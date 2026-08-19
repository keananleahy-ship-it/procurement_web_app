import { Pool } from 'pg'
import { normalizeUom, isMeasureUom, isPerBaseUnitPrice } from '../lib/uom.ts'

// Faithful reproduction of the AW comparison outputs using the engine's own
// pure helpers, so we can see best price / baseline / realizable savings per
// canonical before and after the data fix. Read-only.

const U = 'tCPvdZdKimgMgNDVn82F7cyi8PdwAY4o'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows

function effectiveUnit(unit: string | null, base: string | null): string {
  return !isMeasureUom(base) && isMeasureUom(unit)
    ? normalizeUom(unit)
    : normalizeUom(base)
}

async function main() {
  const cans = await q(
    `select id, name, viscosity from canonical_items
     where "userId"=$1 and category='Hydraulic Fluid' and subcategory='AW' order by viscosity`,
    [U],
  )
  let grandSavings = 0
  for (const c of cans) {
    const groupUnit = 'gallon' // AW canonicals compare in gallons
    const offers = await q(
      `select vp."unitPrice" up, vp."priceBasis" pb, coalesce(vp."shippingCost",0) ship,
              vp."freightTerms" ft, p.unit, p."baseUnit" base, p."packSize" ps
       from vendor_prices vp join products p on p.id=vp."productId"
       where p."canonicalItemId"=$1 and p."matchStatus"='confirmed'`,
      [c.id],
    )
    const comparable: number[] = []
    for (const o of offers) {
      const eu = effectiveUnit(o.unit, o.base)
      if (groupUnit && eu && eu !== groupUnit) continue // unit-mismatch excluded
      const packSize = Number(o.ps) > 0 ? Number(o.ps) : 1
      const perBase = isPerBaseUnitPrice({
        unit: o.unit,
        baseUnit: o.base,
        storedBasis: o.pb,
      })
      const scale = perBase ? packSize : 1
      const unitPrice = Number(o.up) * scale
      const ship = o.ft === 'delivered' ? 0 : Number(o.ship)
      const landed = unitPrice + ship
      comparable.push(landed / packSize)
    }
    comparable.sort((a, b) => a - b)
    const best = comparable[0] ?? null
    const worst = comparable[comparable.length - 1] ?? null
    const spread = best !== null && worst !== null ? worst - best : 0

    const vols = await q(
      `select "annualVolume" vol, "baseUnit" bu, "baselineUnitCost" bc
       from purchase_volumes where "canonicalItemId"=$1`,
      [c.id],
    )
    let vol = 0
    let savings = 0
    let anchoredVol = 0
    for (const v of vols) {
      const av = Number(v.vol)
      vol += av
      const bc = v.bc === null ? null : Number(v.bc)
      const unitOk = !v.bu || normalizeUom(v.bu) === groupUnit
      let perUnit: number
      if (best !== null && bc !== null && bc > 0 && unitOk) {
        perUnit = Math.max(0, bc - best)
        anchoredVol += av
      } else {
        perUnit = spread
      }
      savings += perUnit * av
    }
    grandSavings += savings
    console.log(
      `${c.viscosity.padEnd(10)} best=${best !== null ? '$' + best.toFixed(2) : '-'} worst=${worst !== null ? '$' + worst.toFixed(2) : '-'} ` +
        `offers(cmp)=${comparable.length}/${offers.length} vol=${vol} anchored=${Math.round((anchoredVol / (vol || 1)) * 100)}% savings=$${Math.round(savings).toLocaleString()}`,
    )
  }
  console.log(`\nAW TOTAL realizable savings = $${Math.round(grandSavings).toLocaleString()}`)
}

await main()
await pool.end()
