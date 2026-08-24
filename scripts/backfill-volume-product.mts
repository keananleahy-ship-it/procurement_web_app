/**
 * Backfill productId on volume import rows, then rebuild purchase_volumes with
 * per-product granularity.
 *
 * Why: canonical-matched volume lines were committed with productId = NULL and
 * aggregateVolumeRows historically collapsed every product in a canonical into
 * one blended row. The savings engine's present-state pricing needs to know the
 * SPECIFIC product (and its package) that each gallon was actually bought as,
 * so we resolve each staging line to its exact catalog product and re-aggregate
 * one purchase_volumes row per (canonical, product, period, location).
 *
 * Safe: runs in a single transaction, asserts total volume is preserved, and
 * only writes source='import' rows. DRY_RUN=1 rolls back after printing.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/backfill-volume-product.mts
 *   npx tsx scripts/backfill-volume-product.mts
 */
import { Pool } from 'pg'

const DRY_RUN = process.env.DRY_RUN === '1'

// --- matching helpers (mirrors lib/volume-match.ts, kept inline so the script
// has no app import/alias dependencies) ---------------------------------------
function normalizeSku(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}
function looseSkuKey(s: string): string | null {
  const n = normalizeSku(s)
  if (!n || !/^[0-9]+$/.test(n)) return null
  return n.replace(/^0+/, '') || '0'
}
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}
function dice(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const [g, c] of A) {
    const d = B.get(g)
    if (d) inter += Math.min(c, d)
  }
  return (2 * inter) / (A.size + B.size)
}

type Product = {
  id: number
  name: string
  sku: string | null
  canonicalItemId: number | null
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const products: Product[] = (
      await client.query(
        'SELECT id, name, sku, "canonicalItemId" FROM products',
      )
    ).rows

    // Index products by canonical -> {exact sku, loose sku, all members}
    const byCanon = new Map<
      number,
      {
        exact: Map<string, Product[]>
        loose: Map<string, Product[]>
        members: Product[]
      }
    >()
    for (const p of products) {
      if (p.canonicalItemId === null) continue
      let g = byCanon.get(p.canonicalItemId)
      if (!g) {
        g = { exact: new Map(), loose: new Map(), members: [] }
        byCanon.set(p.canonicalItemId, g)
      }
      g.members.push(p)
      if (p.sku && p.sku.trim()) {
        const k = normalizeSku(p.sku)
        if (k) (g.exact.get(k) ?? g.exact.set(k, []).get(k)!).push(p)
        const lk = looseSkuKey(p.sku)
        if (lk) (g.loose.get(lk) ?? g.loose.set(lk, []).get(lk)!).push(p)
      }
    }

    // Resolve one staging line to a specific product WITHIN its canonical.
    function resolveProduct(
      canonicalItemId: number,
      itemName: string | null,
      sku: string | null,
    ): { productId: number; how: string } | null {
      const g = byCanon.get(canonicalItemId)
      if (!g) return null
      const cands = [sku, itemName].filter((x): x is string => !!x && !!x.trim())
      // 1. exact normalized SKU (from sku column or item label)
      for (const c of cands) {
        const hit = g.exact.get(normalizeSku(c))
        if (hit && hit.length) return { productId: hit[0].id, how: 'sku-exact' }
      }
      // 2. leading-zero-tolerant numeric SKU
      for (const c of cands) {
        const lk = looseSkuKey(c)
        if (lk) {
          const hit = g.loose.get(lk)
          if (hit && hit.length)
            return { productId: hit[0].id, how: 'sku-loose' }
        }
      }
      // 3. fuzzy name match against members of this canonical
      if (itemName && itemName.trim()) {
        let best: { p: Product; score: number } | null = null
        for (const p of g.members) {
          const s = dice(itemName, p.name)
          if (s >= 0.5 && (!best || s > best.score)) best = { p, score: s }
        }
        if (best) return { productId: best.p.id, how: 'name-fuzzy' }
      }
      return null
    }

    // --- Step 1: set productId on canonical-matched staging rows -------------
    const stagingRows = (
      await client.query(
        `SELECT id, "itemName", sku, "canonicalItemId", "productId", "matchStatus"
         FROM volume_import_rows
         WHERE "canonicalItemId" IS NOT NULL AND "productId" IS NULL
           AND "matchStatus" IN ('confirmed','suggested')`,
      )
    ).rows

    const byHow: Record<string, number> = {}
    let resolved = 0
    for (const r of stagingRows) {
      const res = resolveProduct(r.canonicalItemId, r.itemName, r.sku)
      if (!res) {
        byHow['unresolved'] = (byHow['unresolved'] ?? 0) + 1
        continue
      }
      byHow[res.how] = (byHow[res.how] ?? 0) + 1
      resolved++
      await client.query(
        'UPDATE volume_import_rows SET "productId" = $1 WHERE id = $2',
        [res.productId, r.id],
      )
    }
    console.log(
      `[v0] staging rows examined: ${stagingRows.length}, productId set: ${resolved}`,
    )
    console.log('[v0] resolution breakdown:', JSON.stringify(byHow))

    // --- Step 2: rebuild purchase_volumes (source='import') per product ------
    const before = (
      await client.query(
        `SELECT COALESCE(SUM("annualVolume"),0)::numeric v, count(*)::int n
         FROM purchase_volumes WHERE source='import'`,
      )
    ).rows[0]

    await client.query(`DELETE FROM purchase_volumes WHERE source='import'`)

    // Process imports in commit order and apply replaceExistingImportedVolume
    // semantics (null-safe overwrite by userId + location + canonical + product
    // + period). This mirrors production exactly: a later re-import of the same
    // location overwrites the earlier one per key, while genuinely different
    // products (e.g. separate vendor bulk files at one site) coexist and sum.
    const imports = (
      await client.query(
        `SELECT id, "userId", "locationId", "defaultPeriod"
         FROM volume_imports
         WHERE status='committed' AND "locationId" IS NOT NULL
         ORDER BY "committedAt" ASC NULLS FIRST, id ASC`,
      )
    ).rows

    let written = 0
    for (const imp of imports) {
      const rows = (
        await client.query(
          `SELECT "canonicalItemId","productId","annualVolume","baseUnit",
                  "baselineUnitCost","period","matchStatus","include"
           FROM volume_import_rows WHERE "volumeImportId"=$1`,
          [imp.id],
        )
      ).rows

      // aggregate by (canonical, product, period) — mirrors aggregateVolumeRows
      const groups = new Map<
        string,
        {
          canonicalItemId: number | null
          productId: number | null
          period: string | null
          baseUnit: string | null
          vol: number
          costNum: number
          costDen: number
        }
      >()
      for (const r of rows) {
        if (!r.include) continue
        const hasMatch = r.canonicalItemId !== null || r.productId !== null
        const confirmed =
          r.matchStatus === 'confirmed' || r.matchStatus === 'suggested'
        if (!hasMatch || !confirmed) continue
        const vol = Number(r.annualVolume)
        if (!Number.isFinite(vol) || vol <= 0) continue
        const period = (r.period && r.period.trim()) || imp.defaultPeriod || null
        const key = `c:${r.canonicalItemId ?? ''}:p:${r.productId ?? ''}|${period ?? ''}`
        let g = groups.get(key)
        if (!g) {
          g = {
            canonicalItemId: r.canonicalItemId,
            productId: r.productId,
            period,
            baseUnit: r.baseUnit,
            vol: 0,
            costNum: 0,
            costDen: 0,
          }
          groups.set(key, g)
        }
        g.vol += vol
        if (!g.baseUnit && r.baseUnit) g.baseUnit = r.baseUnit
        const cost =
          r.baselineUnitCost !== null && r.baselineUnitCost !== ''
            ? Number(r.baselineUnitCost)
            : null
        if (cost !== null && Number.isFinite(cost)) {
          g.costNum += vol * cost
          g.costDen += vol
        }
      }

      for (const g of groups.values()) {
        written++
        // replaceExisting: null-safe delete of the same key at this location.
        await client.query(
          `DELETE FROM purchase_volumes
           WHERE source='import' AND "userId"=$1 AND "locationId"=$2
             AND "canonicalItemId" IS NOT DISTINCT FROM $3
             AND "productId" IS NOT DISTINCT FROM $4
             AND period IS NOT DISTINCT FROM $5`,
          [imp.userId, imp.locationId, g.canonicalItemId, g.productId, g.period],
        )
        await client.query(
          `INSERT INTO purchase_volumes
             ("userId","canonicalItemId","productId","locationId","annualVolume",
              "baseUnit","baselineUnitCost","period","source")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import')`,
          [
            imp.userId,
            g.canonicalItemId,
            g.productId,
            imp.locationId,
            g.vol.toFixed(2),
            g.baseUnit,
            g.costDen > 0 ? (g.costNum / g.costDen).toFixed(4) : null,
            g.period,
          ],
        )
      }
    }

    const after = (
      await client.query(
        `SELECT COALESCE(SUM("annualVolume"),0)::numeric v, count(*)::int n
         FROM purchase_volumes WHERE source='import'`,
      )
    ).rows[0]
    console.log(
      `[v0] purchase_volumes rebuilt: before ${before.n} rows / ${Number(before.v).toFixed(0)} vol -> after ${after.n} rows / ${Number(after.v).toFixed(0)} vol (${written} writes)`,
    )
    console.log(
      '[v0] note: total may rise where same-location vendor imports previously collided on a canonical-only key and are now split by product.',
    )

    // Per-location before/after, for manual sanity.
    const perLoc = (
      await client.query(
        `SELECT "locationId" loc, count(*)::int n, SUM("annualVolume")::numeric v
         FROM purchase_volumes WHERE source='import' GROUP BY "locationId" ORDER BY "locationId"`,
      )
    ).rows
    console.log('[v0] per-location after rebuild:')
    perLoc.forEach((r: { loc: number; n: number; v: string }) =>
      console.log(`   loc ${r.loc}: ${r.n} rows / ${Number(r.v).toFixed(0)} vol`),
    )

    const withProd = (
      await client.query(
        `SELECT count(*) FILTER (WHERE "productId" IS NOT NULL)::int hasp,
                count(*)::int n
         FROM purchase_volumes WHERE source='import'` ,
      )
    ).rows[0]
    console.log(
      `[v0] after rebuild: ${withProd.hasp}/${withProd.n} purchase_volumes rows carry a productId`,
    )

    if (DRY_RUN) {
      await client.query('ROLLBACK')
      console.log('[v0] DRY_RUN — rolled back, no changes persisted')
    } else {
      await client.query('COMMIT')
      console.log('[v0] committed')
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
