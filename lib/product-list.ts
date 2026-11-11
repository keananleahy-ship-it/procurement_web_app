import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { locations, products, purchaseVolumes } from '@/lib/db/schema'
import { getAllRows } from '@/lib/comparison'

// One row per product at each location it is priced or purchased at. A
// product with neither appears once with no location.
export type ProductListRow = {
  key: string
  productId: number
  name: string
  sku: string | null
  unit: string | null
  baseUnit: string | null
  supplier: string | null
  brand: string | null
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
  packageType: string | null
  performanceSpec: string | null
  location: string | null
  volume: number | null
  volumeUnit: string | null
  volumePeriod: string | null
  paidPerBaseUnit: number | null
  lastPaid: number | null
  lastPaidDate: string | null
  price: number | null
  pricePerBaseUnit: number | null
  priceDate: string | null
}

type LocAgg = {
  name: string | null
  volume: number
  paidWeighted: number
  paidVolume: number
  volumeUnit: string | null
  periods: Set<string>
  lastPaid: { cost: number; date: string } | null
  price: { landed: number; perBase: number; date: string | null } | null
}

export async function buildProductList(): Promise<ProductListRow[]> {
  const [prods, priceRows, volumeRows] = await Promise.all([
    db.select().from(products),
    getAllRows(),
    db
      .select({
        productId: purchaseVolumes.productId,
        locationId: purchaseVolumes.locationId,
        locationName: locations.name,
        annualVolume: purchaseVolumes.annualVolume,
        baselineUnitCost: purchaseVolumes.baselineUnitCost,
        baseUnit: purchaseVolumes.baseUnit,
        period: purchaseVolumes.period,
        lastUnitCost: purchaseVolumes.lastUnitCost,
        lastPurchaseDate: purchaseVolumes.lastPurchaseDate,
      })
      .from(purchaseVolumes)
      .leftJoin(locations, eq(locations.id, purchaseVolumes.locationId)),
  ])

  const byProduct = new Map<number, Map<number | null, LocAgg>>()
  const slot = (productId: number, locationId: number | null, name: string | null) => {
    let perLoc = byProduct.get(productId)
    if (!perLoc) byProduct.set(productId, (perLoc = new Map()))
    let agg = perLoc.get(locationId)
    if (!agg) {
      agg = {
        name,
        volume: 0,
        paidWeighted: 0,
        paidVolume: 0,
        volumeUnit: null,
        periods: new Set(),
        lastPaid: null,
        price: null,
      }
      perLoc.set(locationId, agg)
    }
    return agg
  }

  for (const v of volumeRows) {
    if (v.productId == null) continue
    const vol = Number(v.annualVolume ?? 0)
    if (!Number.isFinite(vol) || vol <= 0) continue
    const agg = slot(v.productId, v.locationId, v.locationName)
    agg.volume += vol
    agg.volumeUnit ??= v.baseUnit
    if (v.period) agg.periods.add(v.period)
    const paid = v.baselineUnitCost != null ? Number(v.baselineUnitCost) : NaN
    if (Number.isFinite(paid) && paid > 0) {
      agg.paidWeighted += paid * vol
      agg.paidVolume += vol
    }
    const last = v.lastUnitCost != null ? Number(v.lastUnitCost) : NaN
    const lastDate = v.lastPurchaseDate ? String(v.lastPurchaseDate).slice(0, 10) : null
    if (Number.isFinite(last) && last > 0 && lastDate && (!agg.lastPaid || lastDate > agg.lastPaid.date)) {
      agg.lastPaid = { cost: last, date: lastDate }
    }
  }

  // Latest quote per product + location; ties go to the cheaper one.
  for (const p of priceRows) {
    const agg = slot(p.productId, p.locationId, p.locationName)
    const cur = agg.price
    const date = p.effectiveDate
    const newer = !cur || (date ?? '') > (cur.date ?? '')
    const sameDateCheaper =
      cur && (date ?? '') === (cur.date ?? '') && p.pricePerBaseUnit < cur.perBase
    if (newer || sameDateCheaper) {
      agg.price = { landed: p.landedUnitCost, perBase: p.pricePerBaseUnit, date }
    }
  }

  const rows: ProductListRow[] = []
  for (const p of prods) {
    if (p.matchStatus === 'excluded') continue
    const base = {
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      baseUnit: p.baseUnit ?? p.unit,
      supplier: p.supplier,
      brand: p.brand,
      category: p.category,
      application: p.application,
      subcategory: p.subcategory,
      viscosity: p.viscosity,
      packageType: p.packageType,
      performanceSpec: p.performanceSpec,
    }
    const perLoc = byProduct.get(p.id)
    if (!perLoc || perLoc.size === 0) {
      rows.push({
        ...base,
        key: `${p.id}:none`,
        location: null,
        volume: null,
        volumeUnit: null,
        volumePeriod: null,
        paidPerBaseUnit: null,
        lastPaid: null,
        lastPaidDate: null,
        price: null,
        pricePerBaseUnit: null,
        priceDate: null,
      })
      continue
    }
    for (const [locationId, a] of perLoc) {
      rows.push({
        ...base,
        key: `${p.id}:${locationId ?? 'none'}`,
        location: a.name,
        volume: a.volume > 0 ? a.volume : null,
        volumeUnit: a.volumeUnit ?? base.baseUnit,
        volumePeriod: a.periods.size ? Array.from(a.periods).join(', ') : null,
        paidPerBaseUnit: a.paidVolume > 0 ? a.paidWeighted / a.paidVolume : null,
        lastPaid: a.lastPaid?.cost ?? null,
        lastPaidDate: a.lastPaid?.date ?? null,
        price: a.price?.landed ?? null,
        pricePerBaseUnit: a.price?.perBase ?? null,
        priceDate: a.price?.date ?? null,
      })
    }
  }
  return rows
}
