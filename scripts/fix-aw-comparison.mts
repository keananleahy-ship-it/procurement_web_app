import { Pool } from 'pg'
import { normalizeUom, isMeasureUom, isPerBaseUnitPrice } from '../lib/uom.ts'

// Data-only cleanup of the AW hydraulic comparison inputs. Two problems fixed:
//
//  1. OFFERS: one Mesa row is stored with a container pricing unit ("drum")
//     even though its price is really per gallon, so the engine flags it
//     unit-mismatched and drops it from ranking. (The UG6/each rows look wrong
//     but are already handled: their baseUnit is a real measure and packSize=1,
//     so they price and rank correctly.) We also normalize the garbled "UG6"
//     spelling to "USG" for hygiene — no output change, packSize is 1.
//
//  2. BASELINES (purchase_volumes): the paid-cost anchor is stored in mixed
//     units. A handful of rows hold a per-PACKAGE dollar figure with no unit,
//     which the savings math trusts as $/gallon and turns into fake savings.
//     Many more hold a correct $/gallon figure but labelled with a pack
//     descriptor ("each", "55", "55 gallon", "5 gal", "1") that normalizeUom
//     doesn't equate to "gallon", so the real paid cost is ignored and savings
//     silently fall back to the vendor spread. We normalize every AW baseline
//     row to per-gallon: convert the per-package ones by pack size, relabel the
//     rest.
//
// Run with DRY_RUN=1 to preview. Scoped strictly to Hydraulic Fluid / AW.

const DRY = process.env.DRY_RUN === '1'
const U = 'tCPvdZdKimgMgNDVn82F7cyi8PdwAY4o'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows

// A baseline dollar figure this high cannot be per-gallon for AW hydraulic
// (real per-gal costs top out < ~$12); treat it as a per-package price.
const PER_PACKAGE_THRESHOLD = 40
// Standard container sizes in gallons, tried largest-first.
const DRUM_GAL = 55
const PAIL_GAL = 5
// Plausible per-gallon band used to pick which container a per-package price
// divides into cleanly.
const PLAUSIBLE = (x: number) => x >= 3 && x <= 20

// Convert a per-package baseline to per-gallon by inferring the container:
// prefer drum (÷55) when the result is plausible, else pail (÷5).
function toPerGallon(cost: number): { perGal: number; pack: number } {
  if (PLAUSIBLE(cost / DRUM_GAL)) return { perGal: cost / DRUM_GAL, pack: DRUM_GAL }
  return { perGal: cost / PAIL_GAL, pack: PAIL_GAL }
}

async function main() {
  const client = await pool.connect()
  const log: string[] = []
  try {
    await client.query('begin')

    // AW canonical ids (Hydraulic Fluid / subcategory 'AW').
    const canonIds = (
      await q(
        `select id from canonical_items where "userId"=$1 and category='Hydraulic Fluid' and subcategory='AW'`,
        [U],
      )
    ).map((r) => r.id as number)
    log.push(`AW canonicals: ${canonIds.length}`)

    // ---- 1. OFFERS ---------------------------------------------------------
    // Products matched to an AW canonical whose pricing unit is a non-measure
    // container word -> re-tag to gallon so they rank. Also fix UG6 -> USG.
    const offerProds = await q(
      `select p.id, p.name, p.unit, p."baseUnit", p."packSize"
       from products p
       where p."userId"=$1 and p."canonicalItemId" = any($2) and p."matchStatus"='confirmed'`,
      [U, canonIds],
    )
    let drumFix = 0
    let ug6Fix = 0
    for (const p of offerProds) {
      const unitIsMeasure = isMeasureUom(p.unit)
      const baseIsMeasure = isMeasureUom(p.baseUnit)
      // Truly excluded: neither pricing unit nor base unit is a measure.
      if (!unitIsMeasure && !baseIsMeasure) {
        log.push(
          `  OFFER drum->gallon: P#${p.id} unit=${JSON.stringify(p.unit)} base=${JSON.stringify(p.baseUnit)} pack=${p.packSize} | ${p.name}`,
        )
        if (!DRY)
          await client.query(
            `update products set unit='gallon', "baseUnit"='gallon' where id=$1`,
            [p.id],
          )
        drumFix++
        continue
      }
      // Hygiene: garbled "UG6" pricing unit -> "USG" (no output change).
      if (String(p.unit).trim().toLowerCase() === 'ug6') {
        if (!DRY)
          await client.query(`update products set unit='USG' where id=$1`, [p.id])
        ug6Fix++
      }
    }
    log.push(`OFFERS: drum->gallon=${drumFix}, ug6->usg=${ug6Fix}`)

    // ---- 2. BASELINES ------------------------------------------------------
    const vols = await q(
      `select id, "annualVolume" vol, "baseUnit" bu, "baselineUnitCost" bc
       from purchase_volumes
       where "userId"=$1 and "canonicalItemId" = any($2) and "baselineUnitCost" is not null`,
      [U, canonIds],
    )
    let converted = 0
    let relabelled = 0
    for (const v of vols) {
      const cost = Number(v.bc)
      if (cost > PER_PACKAGE_THRESHOLD) {
        const { perGal, pack } = toPerGallon(cost)
        log.push(
          `  BASELINE convert: V#${v.id} $${cost.toFixed(2)} /${pack} -> $${perGal.toFixed(4)}/gal (unit was ${JSON.stringify(v.bu)})`,
        )
        if (!DRY)
          await client.query(
            `update purchase_volumes set "baselineUnitCost"=$1, "baseUnit"='gallon' where id=$2`,
            [perGal, v.id],
          )
        converted++
      } else if (normalizeUom(v.bu) !== 'gallon') {
        log.push(
          `  BASELINE relabel: V#${v.id} $${cost.toFixed(4)}/gal unit ${JSON.stringify(v.bu)} -> gallon`,
        )
        if (!DRY)
          await client.query(
            `update purchase_volumes set "baseUnit"='gallon' where id=$1`,
            [v.id],
          )
        relabelled++
      }
    }
    log.push(`BASELINES: converted=${converted}, relabelled=${relabelled}`)

    if (DRY) {
      await client.query('rollback')
      log.push('DRY_RUN -> ROLLED BACK')
    } else {
      await client.query('commit')
      log.push('COMMITTED')
    }
  } catch (e) {
    await client.query('rollback')
    log.push(`ERROR -> ROLLED BACK: ${(e as Error).message}`)
    console.log(log.join('\n'))
    throw e
  } finally {
    client.release()
  }
  console.log(log.join('\n'))
}

await main()
await pool.end()
