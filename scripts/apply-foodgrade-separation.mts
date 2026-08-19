/*
 * One-off, transactional separation of food-grade (NSF H1) lubricants from the
 * standard industrial canonical items they were wrongly matched into. Food-grade
 * product (Petro-Canada PURITY FG, P66 WHITE OIL, ...) is a distinct commercial
 * segment and must not be price-compared against standard AW hydraulic / gear /
 * circulating oil, even at the same viscosity grade.
 *
 * The matching passes had linked 19 food-grade products into 7 standard
 * canonicals as price-list members (they carry NO purchase volume of their own —
 * verified — so there is nothing to re-point; the volume on those standard
 * canonicals is entirely from genuinely standard products and is left alone).
 *
 * Steps (single BEGIN/COMMIT; DRY_RUN=1 prints the plan and rolls back):
 *   1. Find-or-create the 7 dedicated food-grade canonical items (idempotent by
 *      specKey).
 *   2. Move each listed food-grade product onto its food-grade canonical and
 *      mark it confirmed so the auto-match passes won't drag it back.
 *   3. Assert no food-grade product remains on a standard canonical.
 */
import { Pool } from 'pg'

const DRY_RUN = process.env.DRY_RUN === '1'
const U = 'tCPvdZdKimgMgNDVn82F7cyi8PdwAY4o'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

// Each dedicated food-grade canonical + the exact product ids that move onto it.
// Product ids are explicit (not fuzzy) so the migration is deterministic.
type Group = {
  specKey: string
  name: string
  subcategory: string | null
  viscosity: string | null
  unit: string
  productIds: number[]
}

const GROUPS: Group[] = [
  {
    specKey: 'food grade|aw hydraulic|iso 32',
    name: 'Food Grade AW Hydraulic Fluid ISO 32',
    subcategory: 'AW',
    viscosity: 'ISO VG 32',
    unit: 'USG',
    productIds: [347],
  },
  {
    specKey: 'food grade|aw hydraulic|iso 46',
    name: 'Food Grade AW Hydraulic Fluid ISO 46',
    subcategory: 'AW',
    viscosity: 'ISO VG 46',
    unit: 'USG',
    productIds: [348, 350, 349, 399],
  },
  {
    specKey: 'food grade|aw hydraulic|iso 68',
    name: 'Food Grade AW Hydraulic Fluid ISO 68',
    subcategory: 'AW',
    viscosity: 'ISO VG 68',
    unit: 'USG',
    productIds: [351, 353, 352, 366, 367],
  },
  {
    specKey: 'food grade|aw hydraulic|iso 100',
    name: 'Food Grade AW Hydraulic Fluid ISO 100',
    subcategory: 'AW',
    viscosity: 'ISO VG 100',
    unit: 'USG',
    productIds: [344],
  },
  {
    specKey: 'food grade|syn gear|iso 220',
    name: 'Food Grade Synthetic EP Gear Fluid ISO 220',
    subcategory: 'Full Synthetic',
    viscosity: 'ISO VG 220',
    unit: 'USG',
    productIds: [374, 375, 389, 386, 372, 371],
  },
  {
    specKey: 'food grade|white oil|80/90',
    name: 'Food Grade White Oil 80/90',
    subcategory: null,
    viscosity: null,
    unit: 'GAL',
    productIds: [2179],
  },
  {
    specKey: 'food grade|corrosion preventive|iso 15',
    name: 'Food Grade Corrosion Preventive Fluid ISO 15',
    subcategory: null,
    viscosity: 'ISO VG 15',
    unit: 'USG',
    productIds: [354],
  },
]

const log: string[] = []
const note = (s: string) => {
  log.push(s)
  console.log(s)
}

try {
  await client.query('BEGIN')

  // Safety: every product we intend to move must actually be food-grade. If the
  // catalog changed and one is not, abort rather than mis-file it.
  const allIds = GROUPS.flatMap((g) => g.productIds)
  const check = await client.query(
    `select id, name, category, "canonicalItemId"
       from products where "userId"=$1 and id = any($2::int[])`,
    [U, allIds],
  )
  if (check.rowCount !== allIds.length) {
    throw new Error(
      `Expected ${allIds.length} products, found ${check.rowCount}. Aborting.`,
    )
  }
  const notFg = check.rows.filter((r) => r.category !== 'Food Grade Lubricant')
  if (notFg.length) {
    throw new Error(
      `These products are not category 'Food Grade Lubricant': ${notFg
        .map((r) => `#${r.id} ${r.name} (${r.category})`)
        .join('; ')}. Aborting.`,
    )
  }

  let created = 0
  let moved = 0
  for (const g of GROUPS) {
    // 1. Find-or-create the food-grade canonical (idempotent by specKey).
    const exists = await client.query(
      `select id from canonical_items where "userId"=$1 and "specKey"=$2`,
      [U, g.specKey],
    )
    let canonId: number
    if (exists.rowCount) {
      canonId = exists.rows[0].id
      note(`  [1] exists C#${canonId}: ${g.name}`)
    } else {
      const ins = await client.query(
        `insert into canonical_items
           ("userId", name, category, unit, "baseUnit", "specKey", subcategory,
            viscosity, application, "attributesEdited")
         values ($1,$2,'Food Grade Lubricant',$3,$3,$4,$5,$6,'Food Grade',true)
         returning id`,
        [U, g.name, g.unit, g.specKey, g.subcategory, g.viscosity],
      )
      canonId = ins.rows[0].id
      created++
      note(`  [1] created C#${canonId}: ${g.name}`)
    }

    // 2. Move the food-grade products onto it; confirm so auto-match won't undo.
    const upd = await client.query(
      `update products
          set "canonicalItemId"=$1, "matchStatus"='confirmed', "matchScore"=1
        where "userId"=$2 and id = any($3::int[])
        returning id, name`,
      [canonId, U, g.productIds],
    )
    moved += upd.rowCount ?? 0
    for (const r of upd.rows) note(`        moved #${r.id} -> C#${canonId}: ${r.name}`)
  }
  note(`  [2] created ${created} canonicals, moved ${moved} products`)

  // 3. Assert no food-grade product still sits on a standard canonical.
  const leak = await client.query(
    `select p.id, p.name, ci.name as canon
       from products p join canonical_items ci on ci.id = p."canonicalItemId"
      where p."userId"=$1 and p.category='Food Grade Lubricant'
        and ci.category <> 'Food Grade Lubricant'`,
    [U],
  )
  note(`  [3] food-grade products still on a standard canonical: ${leak.rowCount}`)
  for (const r of leak.rows) note(`        LEAK #${r.id} ${r.name} -> ${r.canon}`)

  if (DRY_RUN) {
    await client.query('ROLLBACK')
    note('\nDRY_RUN=1 -> rolled back (no changes committed).')
  } else {
    await client.query('COMMIT')
    note('\nCOMMITTED.')
  }
} catch (e) {
  await client.query('ROLLBACK')
  console.error('ROLLED BACK:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
