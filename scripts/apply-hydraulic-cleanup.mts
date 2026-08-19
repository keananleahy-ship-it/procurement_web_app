/*
 * One-off, transactional cleanup of the Hydraulic Fluid category for the demo.
 * Everything runs inside a single BEGIN/COMMIT; any error rolls the whole thing
 * back. Set DRY_RUN=1 to print the plan and roll back without committing.
 *
 * Steps (in order):
 *   1. Recategorize genuinely non-hydraulic items OUT of the category and
 *      un-match them from any hydraulic canonical.
 *   2. Move the 5 mis-filed Multigrade canonicals into Hydraulic Fluid.
 *   3. Retag canonical formulation (subcategory): AW family -> 'AW',
 *      Multigrade family -> 'MV/HVI'.
 *   4. Create the new canonicals (MV/HVI ISO 100, Zinc-Free 32/46/68,
 *      Zinc-Free HVI 32/46, Full Synthetic 46).
 *   5. Rule-match every remaining hydraulic product to a canonical by
 *      (formulation derived from name, ISO viscosity grade); default a
 *      formulation-less hydraulic to AW.
 *   6. Re-point product-level purchase volume onto the matched canonical so it
 *      aggregates in the compare view.
 */
import { Pool } from 'pg'
import { deriveSubcategory } from '../lib/attributes.ts'

const DRY_RUN = process.env.DRY_RUN === '1'
const U = 'tCPvdZdKimgMgNDVn82F7cyi8PdwAY4o'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

// Formulation label -> specKey token, matching the existing |aw / |mv convention.
const FORM_TOKEN: Record<string, string> = {
  AW: 'aw',
  'MV/HVI': 'mv',
  'Zinc-Free': 'zf',
  'Zinc-Free HVI': 'zfhv',
  'Full Synthetic': 'syn',
  'R&O': 'ro',
}

// Pull the ISO grade number out of "ISO VG 46" / "46" / a name like "... 46 BULK".
function isoNum(viscosity: string | null, name: string): number | null {
  const fromVisc = viscosity?.match(/(\d{1,3})/)?.[1]
  if (fromVisc) return Number(fromVisc)
  const fromName = name.toUpperCase().match(/\bISO\s*(?:VG)?\s*(\d{1,3})\b/)?.[1]
  return fromName ? Number(fromName) : null
}

const log: string[] = []
const note = (s: string) => {
  log.push(s)
  console.log(s)
}

try {
  await client.query('BEGIN')

  // ---- 1. Recategorize non-hydraulic items OUT + un-match them ----------
  // name pattern -> destination category. These are genuinely different
  // product classes that were sitting in / matched into Hydraulic Fluid.
  const recats: { label: string; like: string; category: string }[] = [
    { label: 'VERSATRANS (transmission)', like: '%VERSATRANS%', category: 'Transmission Fluid' },
    { label: 'X/C Aviation 5606', like: '%AVIATION%', category: 'Aviation Hydraulic Fluid' },
    { label: 'ACCUFLO (turbine/circulating)', like: '%ACCUFLO%', category: 'Turbine Oil' },
    { label: 'Honda PSF-2 (power steering)', like: '%PSF%', category: 'Power Steering Fluid' },
  ]
  for (const r of recats) {
    const res = await client.query(
      `update products set category=$1, "canonicalItemId"=null, "matchStatus"='unmatched'
       where "userId"=$2 and name ilike $3
         and (category ilike '%hydraulic%' or "canonicalItemId" in (417,421,471,472,473,480))
       returning id`,
      [r.category, U, r.like],
    )
    note(`  [1] ${r.label}: recategorized+unmatched ${res.rowCount} product(s) -> ${r.category}`)
  }

  // MULTI-WAY belongs on the Way Oil canonical (C#473), not a hydraulic one.
  const mw = await client.query(
    `update products set "canonicalItemId"=473, "matchStatus"='confirmed', category='Way & Slideway Oil'
     where "userId"=$1 and name ilike '%MULTI-WAY%' returning id`,
    [U],
  )
  note(`  [1] MULTI-WAY -> Way Oil C#473: ${mw.rowCount} product(s)`)

  // ---- 2. Move the 5 Multigrade canonicals into Hydraulic Fluid ---------
  const mv = await client.query(
    `update canonical_items set category='Hydraulic Fluid'
     where id in (417,421,471,472,480) returning id`,
  )
  note(`  [2] Moved ${mv.rowCount} Multigrade canonicals -> Hydraulic Fluid`)

  // ---- 3. Retag canonical formulation ----------------------------------
  const aw = await client.query(
    `update canonical_items set subcategory='AW'
     where id in (495,468,419,415,416,420,418,498) returning id`,
  )
  const mvtag = await client.query(
    `update canonical_items set subcategory='MV/HVI'
     where id in (417,421,471,472,480) returning id`,
  )
  note(`  [3] Retagged ${aw.rowCount} canonicals -> AW, ${mvtag.rowCount} -> MV/HVI`)

  // ---- 4. Create the new canonicals ------------------------------------
  const newCanon: { form: string; iso: number; name: string }[] = [
    { form: 'MV/HVI', iso: 100, name: 'Multigrade (MV/HVI) Hydraulic Oil ISO 100' },
    { form: 'Zinc-Free', iso: 32, name: 'Zinc-Free (Ashless) Hydraulic Oil ISO 32' },
    { form: 'Zinc-Free', iso: 46, name: 'Zinc-Free (Ashless) Hydraulic Oil ISO 46' },
    { form: 'Zinc-Free', iso: 68, name: 'Zinc-Free (Ashless) Hydraulic Oil ISO 68' },
    { form: 'Zinc-Free HVI', iso: 32, name: 'Zinc-Free HVI Hydraulic Oil ISO 32' },
    { form: 'Zinc-Free HVI', iso: 46, name: 'Zinc-Free HVI Hydraulic Oil ISO 46' },
    { form: 'Full Synthetic', iso: 46, name: 'Full Synthetic Hydraulic Oil ISO 46' },
  ]
  for (const c of newCanon) {
    const specKey = `hydraulic oil|iso ${c.iso}|${FORM_TOKEN[c.form]}`
    // Idempotent: skip if a canonical with this specKey already exists.
    const exists = await client.query(
      `select id from canonical_items where "userId"=$1 and "specKey"=$2`,
      [U, specKey],
    )
    if (exists.rowCount) {
      note(`  [4] exists, skip: ${c.name}`)
      continue
    }
    const ins = await client.query(
      `insert into canonical_items ("userId", name, category, unit, "baseUnit", "specKey", subcategory, viscosity, application)
       values ($1,$2,'Hydraulic Fluid','USG','USG',$3,$4,$5,'Industrial') returning id`,
      [U, c.name, specKey, c.form, `ISO VG ${c.iso}`],
    )
    note(`  [4] created C#${ins.rows[0].id}: ${c.name}`)
  }

  // ---- 5. Rule-match remaining hydraulic products ----------------------
  // Build (formulation|iso) -> canonicalId lookup from the current hydraulic set.
  const canons = await client.query(
    `select id, subcategory, viscosity, name from canonical_items
     where "userId"=$1 and category='Hydraulic Fluid'`,
    [U],
  )
  const lookup = new Map<string, number>()
  for (const c of canons.rows) {
    const iso = isoNum(c.viscosity, c.name)
    if (c.subcategory && iso !== null) lookup.set(`${c.subcategory}|${iso}`, c.id)
  }

  // Products in scope: hydraulic-category OR still matched to a hydraulic canonical.
  // Skip the ones we deliberately keep separate (distinct spec or no ISO grade).
  const KEEP_SEPARATE =
    /VERSATRANS|AVIATION|ACCUFLO|MULTI-WAY|WAYLUBE|WAY OIL|SLIDEWAY|\bPSF\b|ENVIRON|ULT-?CLN|ALL[\s-]*SEASON|HYKEN|GLACIAL/i
  const pool2 = await client.query(
    `select id, brand, name, viscosity, "canonicalItemId", "matchStatus"
     from products where "userId"=$1
       and (category='Hydraulic Fluid' or "canonicalItemId" in (415,416,418,419,420,468,495,498,417,421,471,472,480))
     order by id`,
    [U],
  )
  let matched = 0
  const unresolved: string[] = []
  for (const p of pool2.rows) {
    if (KEEP_SEPARATE.test(p.name)) continue
    const iso = isoNum(p.viscosity, p.name)
    if (iso === null) {
      unresolved.push(`no-grade: ${p.brand ?? '?'} / ${p.name}`)
      continue
    }
    const form = deriveSubcategory(p.name, 'Hydraulic Fluid') ?? 'AW'
    const canonId = lookup.get(`${form}|${iso}`)
    if (!canonId) {
      unresolved.push(`no-canonical(${form} ISO ${iso}): ${p.brand ?? '?'} / ${p.name}`)
      continue
    }
    await client.query(
      `update products set "canonicalItemId"=$1, "matchStatus"='confirmed', subcategory=$2 where id=$3`,
      [canonId, form, p.id],
    )
    matched++
  }
  note(`  [5] Rule-matched ${matched} products; ${unresolved.length} left unresolved`)
  for (const u of unresolved) note(`        - ${u}`)

  // ---- 6. Re-point product-level volume onto its canonical --------------
  // Only for products now confirmed-matched to a hydraulic canonical. Setting
  // the volume row's canonicalItemId is what makes it aggregate in compare.
  const rep = await client.query(
    `update purchase_volumes pv
       set "canonicalItemId" = p."canonicalItemId", "productId" = null
      from products p
     where pv."productId" = p.id
       and pv."canonicalItemId" is null
       and p."userId"=$1
       and p."matchStatus"='confirmed'
       and p."canonicalItemId" in (
         select id from canonical_items where "userId"=$1 and category='Hydraulic Fluid')
     returning pv.id`,
    [U],
  )
  note(`  [6] Re-pointed ${rep.rowCount} product-level volume rows onto canonicals`)

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
