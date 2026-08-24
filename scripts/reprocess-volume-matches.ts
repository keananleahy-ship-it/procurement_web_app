/**
 * One-off remediation: re-resolve every committed volume import under the
 * vendor-code-identity rule and rebuild purchase_volumes from the retained
 * staging rows.
 *
 * Background: the old importer fell back to a fuzzy NAME match when a vendor
 * code wasn't in the catalog and committed those `suggested` guesses into the
 * savings baseline, merging distinct vendor codes onto one product (e.g.
 * CITGARD 600's bulk code absorbed the separate CASE and DRUM codes). A vendor
 * code is the atomic unit of purchase history — one code = one item = one pack
 * form = one unit — so this rebuilds the data around that invariant, mirroring
 * the fixed commit path (ensureProductsForImport + writeVolumesFromRows) exactly
 * so app code and remediation can't drift.
 *
 * Idempotent: re-running produces the same result (it rebuilds from staging and
 * reuses products it already created via exact-code/name identity).
 *
 * Dry-run by default (rolls back, prints the report). Pass --apply to commit.
 *
 * Run:
 *   npx tsx --env-file-if-exists=/vercel/share/.env.project \
 *     scripts/reprocess-volume-matches.ts            # dry-run
 *   npx tsx --env-file-if-exists=/vercel/share/.env.project \
 *     scripts/reprocess-volume-matches.ts --apply    # commit
 */
import pg from 'pg'
import {
  buildMatchIndex,
  resolveExactIdentity,
  normalizeSku,
  normalizeName,
} from '../lib/volume-match'
import { deriveAttributes } from '../lib/attributes'
import { normalizeUom } from '../lib/uom'

const APPLY = process.argv.includes('--apply')

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

type ProdRow = {
  id: number
  name: string
  category: string | null
  sku: string | null
  canonicalItemId: number | null
}
type CanonRow = { id: number; name: string; category: string | null }
type StagingRow = {
  id: number
  itemName: string
  sku: string | null
  annualVolume: string | null
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
  canonicalItemId: number | null
  productId: number | null
  matchStatus: string
  include: boolean
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ---- BEFORE report -----------------------------------------------------
    const beforeMulti = await client.query(`
      SELECT count(*)::int n FROM (
        SELECT vir."productId"
        FROM volume_import_rows vir JOIN volume_imports vi ON vi.id = vir."volumeImportId"
        WHERE vi.status='committed' AND vir.include=true AND vir."productId" IS NOT NULL
          AND coalesce(trim(vir.sku),'') <> ''
        GROUP BY vir."productId" HAVING count(DISTINCT vir.sku) > 1
      ) t`)
    const beforePv = await client.query(
      `SELECT count(*)::int n FROM purchase_volumes WHERE source='import'`,
    )
    console.log('[v0] === BEFORE ===')
    console.log('[v0] products with >1 committed vendor code:', beforeMulti.rows[0].n)
    console.log('[v0] import purchase_volumes rows:', beforePv.rows[0].n)

    // Wipe all import-sourced baseline rows; we rebuild every committed import
    // below. (Verified: zero non-import purchase_volumes rows exist, so this
    // touches only import data.)
    await client.query(`DELETE FROM purchase_volumes WHERE source='import'`)

    const imports = (
      await client.query(`
        SELECT id, "userId", "locationId", "defaultPeriod"
        FROM volume_imports WHERE status='committed'
        ORDER BY "committedAt" ASC NULLS FIRST, id ASC`)
    ).rows as {
      id: number
      userId: string
      locationId: number
      defaultPeriod: string | null
    }[]

    let productsCreated = 0
    let pvWritten = 0

    for (const imp of imports) {
      // Fresh catalog per import so products created by an earlier import are
      // found by exact code/name here (dedup across the whole run).
      const canon = (
        await client.query(
          `SELECT id, name, category FROM canonical_items WHERE "userId"=$1`,
          [imp.userId],
        )
      ).rows as CanonRow[]
      const prods = (
        await client.query(
          `SELECT id, name, category, sku, "canonicalItemId" FROM products WHERE "userId"=$1`,
          [imp.userId],
        )
      ).rows as ProdRow[]
      const index = buildMatchIndex(canon, prods)

      const rows = (
        await client.query(
          `SELECT id, "itemName", sku, "annualVolume", "baseUnit", "baselineUnitCost",
                  period, "canonicalItemId", "productId", "matchStatus", include
           FROM volume_import_rows WHERE "volumeImportId"=$1`,
          [imp.id],
        )
      ).rows as StagingRow[]

      // Identity key -> resolved ids, so repeat codes/names collapse onto one
      // product within this import.
      const resolved = new Map<
        string,
        { canonicalItemId: number | null; productId: number | null }
      >()
      const identityKey = (sku: string | null, itemName: string) => {
        const code = sku?.trim() ? normalizeSku(sku) : ''
        return code ? `code:${code}` : `name:${normalizeName(itemName)}`
      }

      type Eligible = {
        canonicalItemId: number | null
        productId: number | null
        annualVolume: string | null
        baseUnit: string | null
        baselineUnitCost: string | null
        period: string | null
      }
      const eligible: Eligible[] = []

      for (const r of rows) {
        if (!r.include) continue
        if (r.annualVolume === null || Number(r.annualVolume) <= 0) continue

        let target: { canonicalItemId: number | null; productId: number | null }

        if (
          r.matchStatus === 'confirmed' &&
          (r.canonicalItemId !== null || r.productId !== null)
        ) {
          // Authoritative exact-code match or human pick — keep as-is.
          target = {
            canonicalItemId: r.canonicalItemId,
            productId: r.productId,
          }
        } else {
          const key = identityKey(r.sku, r.itemName)
          const cached = resolved.get(key)
          if (cached) {
            target = cached
          } else {
            const hit = resolveExactIdentity(
              { itemName: r.itemName, sku: r.sku ?? null },
              index,
            )
            if (hit) {
              target = {
                canonicalItemId:
                  hit.target.kind === 'canonical'
                    ? hit.target.canonicalItemId
                    : null,
                productId:
                  hit.target.kind === 'product' ? hit.target.productId : null,
              }
            } else {
              const name = r.itemName.trim()
              const attrs = deriveAttributes(name)
              const ins = await client.query(
                `INSERT INTO products
                   ("userId", name, sku, "baseUnit", unit, brand, category,
                    application, subcategory, viscosity, "packageType",
                    "attributesEdited", "canonicalItemId", "matchStatus")
                 VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,false,NULL,'unmatched')
                 RETURNING id`,
                [
                  imp.userId,
                  name,
                  r.sku?.trim() || null,
                  r.baseUnit?.trim() || null,
                  attrs.brand,
                  attrs.category,
                  attrs.application,
                  attrs.subcategory,
                  attrs.viscosity,
                  attrs.packageType,
                ],
              )
              productsCreated++
              target = { canonicalItemId: null, productId: ins.rows[0].id }
            }
            resolved.set(key, target)
          }

          await client.query(
            `UPDATE volume_import_rows
             SET "canonicalItemId"=$1, "productId"=$2, "matchStatus"='confirmed', "matchName"=$3
             WHERE id=$4`,
            [target.canonicalItemId, target.productId, r.itemName.trim(), r.id],
          )
        }

        eligible.push({
          canonicalItemId: target.canonicalItemId,
          productId: target.productId,
          annualVolume: r.annualVolume,
          baseUnit: r.baseUnit,
          baselineUnitCost: r.baselineUnitCost,
          period: r.period,
        })
      }

      // Aggregate to one summary per (item, period, normalized unit) — same as
      // aggregateVolumeRows — then insert.
      const groups = new Map<
        string,
        {
          canonicalItemId: number | null
          productId: number | null
          period: string | null
          baseUnit: string | null
          totalVolume: number
          costNum: number
          costDen: number
        }
      >()
      for (const r of eligible) {
        const vol = Number(r.annualVolume)
        if (!Number.isFinite(vol) || vol <= 0) continue
        const period = r.period?.trim() || imp.defaultPeriod || null
        const unit = normalizeUom(r.baseUnit)
        const key = `c:${r.canonicalItemId ?? ''}:p:${r.productId ?? ''}|${period ?? ''}|u:${unit}`
        let g = groups.get(key)
        if (!g) {
          g = {
            canonicalItemId: r.canonicalItemId,
            productId: r.productId,
            period,
            baseUnit: r.baseUnit,
            totalVolume: 0,
            costNum: 0,
            costDen: 0,
          }
          groups.set(key, g)
        }
        g.totalVolume += vol
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
        await client.query(
          `INSERT INTO purchase_volumes
             ("userId", "canonicalItemId", "productId", "locationId",
              "annualVolume", "baseUnit", "baselineUnitCost", period, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import')`,
          [
            imp.userId,
            g.canonicalItemId,
            g.productId,
            imp.locationId,
            g.totalVolume.toFixed(2),
            g.baseUnit,
            g.costDen > 0 ? (g.costNum / g.costDen).toFixed(4) : null,
            g.period,
          ],
        )
        pvWritten++
      }
    }

    // ---- AFTER report + assertions ----------------------------------------
    const afterMulti = await client.query(`
      SELECT count(*)::int n FROM (
        SELECT vir."productId"
        FROM volume_import_rows vir JOIN volume_imports vi ON vi.id = vir."volumeImportId"
        WHERE vi.status='committed' AND vir.include=true AND vir."productId" IS NOT NULL
          AND coalesce(trim(vir.sku),'') <> ''
        GROUP BY vir."productId" HAVING count(DISTINCT vir.sku) > 1
      ) t`)
    const suggestedLeft = await client.query(`
      SELECT count(*)::int n FROM volume_import_rows vir JOIN volume_imports vi ON vi.id=vir."volumeImportId"
      WHERE vi.status='committed' AND vir.include=true AND vir."matchStatus" <> 'confirmed'
        AND vir."annualVolume" IS NOT NULL AND vir."annualVolume"::numeric > 0`)
    const citgard = await client.query(`
      SELECT p.sku, pv."baseUnit", pv."annualVolume", pv."baselineUnitCost"
      FROM purchase_volumes pv JOIN products p ON p.id = pv."productId"
      WHERE p.sku = '622615001097' AND pv.source='import'`)
    const citgardName = await client.query(`
      SELECT p.id, p.sku, p.name, p."packageType"
      FROM products p WHERE p.name ILIKE '%CITGARD 600%15/40%' ORDER BY p.id`)

    // Diagnostic: which products still hold >1 distinct vendor code, and which
    // codes — so a residual can be judged (genuine catalog duplicate vs. an
    // over-broad loose-SKU key) rather than just counted.
    const residual = await client.query(`
      SELECT vir."productId" AS pid, p.name, p.sku AS product_sku,
             array_agg(DISTINCT trim(vir.sku)) AS codes
      FROM volume_import_rows vir
      JOIN volume_imports vi ON vi.id = vir."volumeImportId"
      JOIN products p ON p.id = vir."productId"
      WHERE vi.status='committed' AND vir.include=true AND vir."productId" IS NOT NULL
        AND coalesce(trim(vir.sku),'') <> ''
      GROUP BY vir."productId", p.name, p.sku HAVING count(DISTINCT vir.sku) > 1
      ORDER BY vir."productId"`)

    console.log('[v0] === AFTER ===')
    console.log('[v0] products created:', productsCreated)
    for (const r of residual.rows) {
      console.log(
        `[v0]   RESIDUAL product ${r.pid} (sku=${r.product_sku}) "${String(r.name).slice(0, 40)}" <- codes: ${r.codes.join(', ')}`,
      )
    }
    console.log('[v0] import purchase_volumes rows written:', pvWritten)
    // Every remaining multi-code product must be a legitimate catalog ALIAS: all
    // its codes already resolve, via EXACT vendor-code identity, to that same
    // pre-existing product (two codes for one physical pack form). That is
    // allowed. What must be zero is any multi-code product where the merge came
    // from something OTHER than exact-code identity (i.e. the old fuzzy-name
    // merge) — and any code-bearing row folded onto a product this run created.
    // Build an exact-code index from the FINAL catalog state to judge residuals.
    const allCanon = (
      await client.query(`SELECT id, name, category FROM canonical_items`)
    ).rows as CanonRow[]
    const allProds = (
      await client.query(
        `SELECT id, name, category, sku, "canonicalItemId" FROM products`,
      )
    ).rows as ProdRow[]
    const finalIndex = buildMatchIndex(allCanon, allProds)

    // A residual product is legitimate only if EVERY committed staging row on it
    // resolves to that SAME product via EXACT vendor-code identity (the code may
    // live in the sku column OR, per the source's cross-reference quirk, in the
    // itemName field — resolveExactIdentity handles both). If any contributing
    // row would only have matched by fuzzy NAME, that's the old bug and must be
    // zero. We check per row (not per bare code) so the itemName-as-code path is
    // honored exactly as the resolver does it.
    const badMerge: { pid: number; codes: string[] }[] = []
    for (const r of residual.rows) {
      const contributing = (
        await client.query(
          `SELECT DISTINCT vir.sku, vir."itemName"
           FROM volume_import_rows vir JOIN volume_imports vi ON vi.id=vir."volumeImportId"
           WHERE vi.status='committed' AND vir.include=true AND vir."productId"=$1
             AND vir."annualVolume" IS NOT NULL AND vir."annualVolume"::numeric>0`,
          [r.pid],
        )
      ).rows as { sku: string | null; itemName: string }[]
      // Legitimate when every contributing row resolves by EXACT CODE (sku or
      // the itemName-as-code cross-reference) to a single shared target — a
      // product OR a canonical item. What we forbid is a row that would only
      // have matched by fuzzy NAME (method !== 'code') or one with no exact
      // identity at all: that is the old merge bug.
      const targets = new Set<string>()
      let anyFuzzy = false
      for (const row of contributing) {
        const hit = resolveExactIdentity(
          { itemName: row.itemName, sku: row.sku },
          finalIndex,
        )
        if (!hit || hit.method !== 'code') {
          anyFuzzy = true
          break
        }
        targets.add(
          hit.target.kind === 'product'
            ? `p:${hit.target.productId}`
            : `c:${hit.target.canonicalItemId}`,
        )
      }
      if (anyFuzzy || targets.size > 1) {
        badMerge.push({ pid: r.pid, codes: r.codes })
      }
    }

    console.log('[v0] products with >1 committed vendor code:', afterMulti.rows[0].n)
    console.log('[v0]   of which legitimate catalog aliases:', residual.rows.length - badMerge.length)
    console.log('[v0]   of which illegitimate merges:', badMerge.length, '(want 0)')
    console.log('[v0] eligible rows not confirmed:', suggestedLeft.rows[0].n, '(want 0)')
    console.log('[v0] CITGARD 622615001097 pv rows:', JSON.stringify(citgard.rows))
    console.log('[v0] CITGARD 600 15/40 products:', JSON.stringify(citgardName.rows))

    const ok = badMerge.length === 0 && suggestedLeft.rows[0].n === 0

    if (!ok) {
      console.log('[v0] ASSERTIONS FAILED — rolling back regardless of --apply')
      await client.query('ROLLBACK')
      process.exitCode = 1
      return
    }

    if (APPLY) {
      await client.query('COMMIT')
      console.log('[v0] COMMITTED changes.')
    } else {
      await client.query('ROLLBACK')
      console.log('[v0] DRY RUN — rolled back. Re-run with --apply to commit.')
    }
  } catch (e) {
    await client.query('ROLLBACK')
    console.log('[v0] ERROR (rolled back):', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

void main()
