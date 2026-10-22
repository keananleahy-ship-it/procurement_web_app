/**
 * Import the consolidated (multi-company, multi-warehouse) purchase history.
 *
 * - Keeps only Oil lubricant + Grease lines in the trailing 12 months ending at
 *   the file's latest invoice date.
 * - Lines with zero EXTENDED_GALLONS are skipped and written to a report.
 * - Each (company, warehouse) becomes a `warehouses` row rolled up to a main
 *   location by region: LW -> Chicago, Grade A -> New York, all else -> Amarillo.
 *   Existing warehouse assignments are preserved on re-run.
 * - Parts are matched to the catalog by exact / leading-zero-tolerant part
 *   number, or exact name for lines with no part number. Unmatched parts are
 *   created as new 'unmatched' products (one per source database + part).
 * - Replaces all imported volume at the locations the file covers (Hutchens is
 *   untouched), re-deriving purchase_volumes (source='warehouse') per
 *   location + product and carrying over catalog-validation sign-offs.
 *
 * Usage:
 *   DRY_RUN=1 node --env-file-if-exists=/vercel/share/.env.project scripts/import-consolidated-volumes.mts /tmp/consolidated.csv
 *   node --env-file-if-exists=/vercel/share/.env.project scripts/import-consolidated-volumes.mts /tmp/consolidated.csv
 */
import fs from 'node:fs'
import { Pool } from 'pg'
import { deriveAttributes } from '../lib/attributes.ts'

const DRY_RUN = process.env.DRY_RUN === '1'
const FILE = process.argv[2] ?? '/tmp/consolidated.csv'
const REPORT = process.env.REPORT ?? '/tmp/zero-gallon-lines.csv'
const LUBE_LINES = new Set(['oil lubricants', 'grease'])

const normalizeSku = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const normalizeName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function looseSkuKey(s: string): string | null {
  const n = normalizeSku(s)
  if (!n || !/^[0-9]+$/.test(n)) return null
  return n.replace(/^0+/, '') || '0'
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function locationNameFor(company: string): string {
  if (company === 'LW') return 'Chicago'
  if (company === 'Grade A') return 'New York'
  return 'Amarillo'
}

async function insertMany(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  head: string,
  rows: unknown[][],
  chunkSize = 1000,
) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const params: unknown[] = []
    const values = chunk.map((r) => {
      const ph = r.map((v) => {
        params.push(v)
        return `$${params.length}`
      })
      return `(${ph.join(',')})`
    })
    await client.query(`${head} VALUES ${values.join(',')}`, params)
  }
}

type Product = {
  id: number
  name: string
  sku: string | null
  canonicalItemId: number | null
  matchStatus: string
}

async function main() {
  const text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
  const [header, ...data] = parseCsv(text)
  const col = (name: string) => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`missing column ${name}`)
    return i
  }
  const C = {
    company: col('BASE_LEVEL_1'),
    region: col('BASE_LEVEL_2'),
    database: col('DATABASE'),
    warehouse: col('WAREHOUSE_ID_ADJ'),
    date: col('INVOICE_DATE'),
    cost: col('COST_EXTENDED'),
    gallons: col('EXTENDED_GALLONS'),
    part: col('PART_NUMBER'),
    desc: col('DESCRIPTION'),
    shortDesc: col('SHORT_DESCRIPTION'),
    line: col('PBI_PRODUCT_LINE'),
  }
  const rows = data.filter((r) => r.length >= header.length - 1)

  const maxDate = rows.reduce((m, r) => {
    const d = (r[C.date] ?? '').slice(0, 10)
    return d > m ? d : m
  }, '')
  const end = new Date(`${maxDate}T00:00:00Z`)
  const start = new Date(end)
  start.setUTCFullYear(start.getUTCFullYear() - 1)
  start.setUTCDate(start.getUTCDate() + 1)
  const startStr = start.toISOString().slice(0, 10)
  const period = `TTM ${startStr} to ${maxDate}`
  console.log(`[import] ${rows.length} rows, window ${period}`)

  type Group = {
    company: string
    region: string
    warehouse: string
    database: string
    part: string
    name: string
    names: Map<string, number>
    gallons: number
    cost: number
    lines: number
  }
  const groups = new Map<string, Group>()
  const zero = new Map<
    string,
    { company: string; part: string; desc: string; line: string; lines: number; cost: number }
  >()
  let lubeLines = 0
  let zeroLines = 0
  let zeroCost = 0
  let noIdentity = 0

  for (const r of rows) {
    if (!LUBE_LINES.has((r[C.line] ?? '').trim().toLowerCase())) continue
    const d = (r[C.date] ?? '').slice(0, 10)
    if (d < startStr || d > maxDate) continue
    lubeLines++
    const company = r[C.company].trim()
    const part = r[C.part].trim()
    const desc = r[C.desc].trim() || r[C.shortDesc].trim()
    const gallons = Number(r[C.gallons] || 0)
    const cost = Number(r[C.cost] || 0)
    if (!Number.isFinite(gallons) || gallons === 0) {
      zeroLines++
      zeroCost += Number.isFinite(cost) ? cost : 0
      const k = `${company}|${part}|${desc}`
      const z = zero.get(k) ?? { company, part, desc, line: r[C.line].trim(), lines: 0, cost: 0 }
      z.lines++
      z.cost += Number.isFinite(cost) ? cost : 0
      zero.set(k, z)
      continue
    }
    if (!part && !desc) {
      noIdentity++
      continue
    }
    const warehouse = r[C.warehouse].trim() || '(none)'
    const database = r[C.database].trim() || company
    const identity = part ? `c:${normalizeSku(part)}` : `n:${normalizeName(desc)}`
    const key = `${company}|${warehouse.toUpperCase()}|${database}|${identity}`
    let g = groups.get(key)
    if (!g) {
      g = {
        company,
        region: r[C.region].trim(),
        warehouse,
        database,
        part,
        name: desc,
        names: new Map(),
        gallons: 0,
        cost: 0,
        lines: 0,
      }
      groups.set(key, g)
    }
    g.gallons += gallons
    g.cost += Number.isFinite(cost) ? cost : 0
    g.lines++
    if (desc) g.names.set(desc, (g.names.get(desc) ?? 0) + 1)
  }
  for (const g of groups.values()) {
    const best = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0]
    g.name = best?.[0] ?? g.part
  }
  console.log(
    `[import] lube lines in window ${lubeLines}, zero-gallon skipped ${zeroLines} ($${zeroCost.toFixed(0)}), no part/name ${noIdentity}, groups ${groups.size}`,
  )

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id serial PRIMARY KEY,
        "userId" text NOT NULL,
        company text NOT NULL,
        code text NOT NULL,
        region text,
        "locationId" integer NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )`)
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS warehouses_user_company_code ON warehouses ("userId", company, code)`,
    )
    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouse_volumes (
        id serial PRIMARY KEY,
        "userId" text NOT NULL,
        "warehouseId" integer NOT NULL,
        "productId" integer NOT NULL,
        "annualVolume" numeric(14,2) NOT NULL,
        "totalCost" numeric(14,2),
        "baseUnit" text,
        period text,
        "lineCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )`)
    await client.query(
      `CREATE INDEX IF NOT EXISTS warehouse_volumes_warehouse ON warehouse_volumes ("warehouseId")`,
    )

    const locs = (await client.query(`SELECT id, name, "userId" FROM locations`)).rows as {
      id: number
      name: string
      userId: string
    }[]
    const locByName = new Map(locs.map((l) => [l.name, l]))
    const userId = locs[0].userId

    // --- product index --------------------------------------------------
    const products: Product[] = (
      await client.query(`SELECT id, name, sku, "canonicalItemId", "matchStatus" FROM products`)
    ).rows
    const rank = (p: Product) =>
      p.canonicalItemId !== null && p.matchStatus === 'confirmed'
        ? 0
        : p.canonicalItemId !== null
          ? 1
          : 2
    const pick = (list: Product[]) =>
      [...list].sort((a, b) => rank(a) - rank(b) || a.id - b.id)[0]
    const bySku = new Map<string, Product[]>()
    const byLoose = new Map<string, Product[]>()
    const byName = new Map<string, Product[]>()
    const push = (m: Map<string, Product[]>, k: string, p: Product) =>
      (m.get(k) ?? m.set(k, []).get(k)!).push(p)
    for (const p of products) {
      if (p.sku?.trim()) {
        const k = normalizeSku(p.sku)
        if (k) push(bySku, k, p)
        const lk = looseSkuKey(p.sku)
        if (lk) push(byLoose, lk, p)
      }
      const nk = normalizeName(p.name)
      if (nk) push(byName, nk, p)
    }
    const resolve = (g: Group): Product | null => {
      if (g.part) {
        const k = normalizeSku(g.part)
        if (bySku.has(k)) return pick(bySku.get(k)!)
        const lk = looseSkuKey(g.part)
        if (lk && byLoose.has(lk)) return pick(byLoose.get(lk)!)
        return null
      }
      const nk = normalizeName(g.name)
      return byName.has(nk) ? pick(byName.get(nk)!) : null
    }

    // --- resolve / create products -------------------------------------
    const productOf = new Map<string, number>()
    const canonicalOf = new Map<number, number | null>(
      products.map((p) => [p.id, p.canonicalItemId]),
    )
    const created = new Map<string, number>()
    const matchedIds = new Set<number>()
    let createdGallons = 0
    const pendingKeys = new Map<string, string>()
    const toCreate = new Map<string, Group>()
    for (const [key, g] of groups) {
      const hit = resolve(g)
      if (hit) {
        productOf.set(key, hit.id)
        matchedIds.add(hit.id)
        continue
      }
      const newKey = `${g.database}|${g.part ? `c:${normalizeSku(g.part)}` : `n:${normalizeName(g.name)}`}`
      pendingKeys.set(key, newKey)
      if (!toCreate.has(newKey)) toCreate.set(newKey, g)
      createdGallons += g.gallons
    }
    const createList = [...toCreate.entries()]
    for (let i = 0; i < createList.length; i += 400) {
      const chunk = createList.slice(i, i + 400)
      const params: unknown[] = []
      const values = chunk.map(([, g]) => {
        const a = deriveAttributes(g.name, 1)
        const base = params.length
        params.push(
          userId,
          g.name,
          g.part || null,
          `Created from consolidated purchase history (${g.database})`,
          a.brand,
          a.category,
          a.application,
          a.subcategory,
          a.viscosity,
          a.packageType,
        )
        const p = (n: number) => `$${base + n}`
        return `(${p(1)},${p(2)},${p(3)},'gallon',1,'gallon','unmatched',${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)})`
      })
      const res = await client.query(
        `INSERT INTO products
           ("userId", name, sku, unit, "packSize", "baseUnit", "matchStatus", "matchReason",
            brand, category, application, subcategory, viscosity, "packageType")
         VALUES ${values.join(',')}
         RETURNING id, name, sku`,
        params,
      )
      res.rows.forEach((r, j) => {
        const [newKey, g] = chunk[j]
        if (r.name !== g.name || (r.sku ?? '') !== (g.part || '')) {
          throw new Error(`RETURNING order mismatch at ${newKey}`)
        }
        created.set(newKey, r.id)
        canonicalOf.set(r.id, null)
      })
    }
    for (const [key, newKey] of pendingKeys) productOf.set(key, created.get(newKey)!)
    console.log(
      `[import] matched catalog products ${matchedIds.size}, new products created ${created.size} (${createdGallons.toFixed(0)} gal)`,
    )

    // --- warehouses ------------------------------------------------------
    const existingWh = (
      await client.query(`SELECT id, company, code, "locationId" FROM warehouses WHERE "userId"=$1`, [
        userId,
      ])
    ).rows as { id: number; company: string; code: string; locationId: number }[]
    const whId = new Map(existingWh.map((w) => [`${w.company}|${w.code.toUpperCase()}`, w.id]))
    for (const g of groups.values()) {
      const k = `${g.company}|${g.warehouse.toUpperCase()}`
      if (whId.has(k)) continue
      const loc = locByName.get(locationNameFor(g.company))
      if (!loc) throw new Error(`location ${locationNameFor(g.company)} not found`)
      const res = await client.query(
        `INSERT INTO warehouses ("userId", company, code, region, "locationId") VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [userId, g.company, g.warehouse, g.region || null, loc.id],
      )
      whId.set(k, res.rows[0].id)
    }
    const whRows = (
      await client.query(`SELECT id, company, code, "locationId" FROM warehouses WHERE "userId"=$1`, [
        userId,
      ])
    ).rows as { id: number; company: string; code: string; locationId: number }[]
    const whLoc = new Map(whRows.map((w) => [w.id, w.locationId]))
    console.log(`[import] warehouses ${whRows.length}`)

    // --- warehouse_volumes (full replace) -------------------------------
    const wv = new Map<
      string,
      { warehouseId: number; productId: number; gallons: number; cost: number; lines: number }
    >()
    for (const [key, g] of groups) {
      const warehouseId = whId.get(`${g.company}|${g.warehouse.toUpperCase()}`)!
      const productId = productOf.get(key)!
      const k = `${warehouseId}|${productId}`
      const x = wv.get(k) ?? { warehouseId, productId, gallons: 0, cost: 0, lines: 0 }
      x.gallons += g.gallons
      x.cost += g.cost
      x.lines += g.lines
      wv.set(k, x)
    }
    await client.query(`DELETE FROM warehouse_volumes WHERE "userId"=$1`, [userId])
    const positive = [...wv.values()].filter((x) => x.gallons > 0)
    const nonPositive = wv.size - positive.length
    await insertMany(
      client,
      `INSERT INTO warehouse_volumes ("userId","warehouseId","productId","annualVolume","totalCost","baseUnit",period,"lineCount")`,
      positive.map((x) => [
        userId,
        x.warehouseId,
        x.productId,
        x.gallons.toFixed(2),
        x.cost.toFixed(2),
        'gallon',
        period,
        x.lines,
      ]),
    )
    console.log(`[import] warehouse_volumes ${wv.size - nonPositive} (net <= 0 skipped ${nonPositive})`)

    // --- replace location-level volume ----------------------------------
    const coveredLocs = [...new Set(whRows.map((w) => w.locationId))]
    const before = (
      await client.query(
        `SELECT "locationId", count(*)::int n, round(sum("annualVolume"))::text v
         FROM purchase_volumes WHERE "locationId" = ANY($1) AND source IN ('import','warehouse')
         GROUP BY 1 ORDER BY 1`,
        [coveredLocs],
      )
    ).rows
    const signoffs = new Map<string, { at: Date; by: string | null; name: string | null }>()
    for (const r of (
      await client.query(
        `SELECT "locationId","productId","validatedAt","validatedByUserId","validatedByName"
         FROM purchase_volumes
         WHERE "locationId" = ANY($1) AND source IN ('import','warehouse')
           AND "validatedAt" IS NOT NULL AND "productId" IS NOT NULL`,
        [coveredLocs],
      )
    ).rows) {
      signoffs.set(`${r.locationId}|${r.productId}`, {
        at: r.validatedAt,
        by: r.validatedByUserId,
        name: r.validatedByName,
      })
    }
    await client.query(
      `DELETE FROM purchase_volumes WHERE "locationId" = ANY($1) AND source IN ('import','warehouse')`,
      [coveredLocs],
    )
    await client.query(
      `UPDATE volume_imports SET status='discarded',
         note = coalesce(note || ' ', '') || 'Superseded by consolidated purchase history import.'
       WHERE "locationId" = ANY($1) AND status='committed'`,
      [coveredLocs],
    )

    const rollup = new Map<string, { locationId: number; productId: number; gallons: number; cost: number }>()
    for (const x of wv.values()) {
      if (x.gallons <= 0) continue
      const locationId = whLoc.get(x.warehouseId)!
      const k = `${locationId}|${x.productId}`
      const y = rollup.get(k) ?? { locationId, productId: x.productId, gallons: 0, cost: 0 }
      y.gallons += x.gallons
      y.cost += x.cost
      rollup.set(k, y)
    }
    let carried = 0
    const pvRows = [...rollup.entries()].map(([k, y]) => {
      const s = signoffs.get(k)
      if (s) carried++
      return [
        userId,
        canonicalOf.get(y.productId) ?? null,
        y.productId,
        y.locationId,
        y.gallons.toFixed(2),
        'gallon',
        y.cost > 0 ? (y.cost / y.gallons).toFixed(4) : null,
        period,
        'warehouse',
        s?.at ?? null,
        s?.by ?? null,
        s?.name ?? null,
      ]
    })
    await insertMany(
      client,
      `INSERT INTO purchase_volumes
         ("userId","canonicalItemId","productId","locationId","annualVolume","baseUnit",
          "baselineUnitCost",period,source,"validatedAt","validatedByUserId","validatedByName")`,
      pvRows,
    )
    const after = (
      await client.query(
        `SELECT "locationId", count(*)::int n, round(sum("annualVolume"))::text v,
                round(sum("annualVolume"*"baselineUnitCost"))::text cost
         FROM purchase_volumes WHERE "locationId" = ANY($1) GROUP BY 1 ORDER BY 1`,
        [coveredLocs],
      )
    ).rows
    console.log('[import] before (import rows):', JSON.stringify(before))
    console.log('[import] after:', JSON.stringify(after))
    console.log(`[import] validation sign-offs carried over ${carried} of ${signoffs.size}`)
    const totalGal = [...rollup.values()].reduce((s, y) => s + y.gallons, 0)
    const totalCost = [...rollup.values()].reduce((s, y) => s + y.cost, 0)
    console.log(
      `[import] total ${totalGal.toFixed(0)} gal, $${totalCost.toFixed(0)}, avg $${(totalCost / totalGal).toFixed(2)}/gal`,
    )

    // Per-company coverage inside the window, to flag partial-year companies.
    const firstSeen = new Map<string, string>()
    for (const r of rows) {
      if (!LUBE_LINES.has((r[C.line] ?? '').trim().toLowerCase())) continue
      const c = r[C.company].trim()
      const d = (r[C.date] ?? '').slice(0, 10)
      if (!firstSeen.has(c) || d < firstSeen.get(c)!) firstSeen.set(c, d)
    }
    console.log('[import] first lube invoice per company:', JSON.stringify(Object.fromEntries(firstSeen)))

    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const lines = ['company,part_number,description,product_line,lines,cost']
    for (const z of [...zero.values()].sort((a, b) => a.company.localeCompare(b.company) || b.cost - a.cost)) {
      lines.push([esc(z.company), esc(z.part), esc(z.desc), esc(z.line), z.lines, z.cost.toFixed(2)].join(','))
    }
    fs.writeFileSync(REPORT, lines.join('\n'))
    console.log(`[import] zero-gallon report: ${REPORT} (${zero.size} groups)`)

    if (DRY_RUN) {
      await client.query('ROLLBACK')
      console.log('[import] DRY_RUN, rolled back')
    } else {
      await client.query('COMMIT')
      console.log('[import] committed')
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
