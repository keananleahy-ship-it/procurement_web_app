'use server'

import { db } from '@/lib/db'
import {
  canonicalItems,
  locations,
  products,
  vendorPrices,
  vendors,
} from '@/lib/db/schema'
import { requireUser } from '@/lib/roles'
import { eq } from 'drizzle-orm'

export type PriceRow = {
  priceId: number
  productId: number
  productName: string
  category: string | null
  unit: string | null
  // vendor part number for this specific offer/container
  sku: string | null
  vendorId: number
  vendorName: string
  locationId: number | null
  locationName: string | null
  unitPrice: number
  // inbound freight per selling unit applied to the landed cost below
  shippingCost: number
  // inbound freight per selling (gallon) unit, for the freight column
  freightPerBaseUnit: number
  // true when shippingCost is a user-supplied estimate, not a quoted figure
  freightEstimated: boolean
  // true when this is an FOB offer with no freight supplied, so its landed
  // cost understates the true delivered cost and it can't be ranked fairly
  freightIncomplete: boolean
  currency: string
  // freight basis: 'fob' | 'delivered' | 'both'
  freightTerms: string
  deliveredPrice: number | null
  // which basis was used to compute the landed cost below ('fob' | 'delivered')
  effectiveBasis: 'fob' | 'delivered'
  // landed cost per SELLING unit, freight-adjusted for the basis above
  landedUnitCost: number
  // physical container capacity, normalized to gallons (e.g. a 205 L drum =>
  // ~54.17). Display/analysis only — does NOT affect price ranking.
  packSize: number
  // this offer's pricing base unit of measure (gallons for fuel/lube vendors)
  baseUnit: string | null
  // the canonical item's base unit, when this offer belongs to a canonical
  // group; used to detect when an offer can't be compared apples-to-apples
  canonicalBaseUnit: string | null
  // true when this offer's base unit differs from its group's base unit, so it
  // is excluded from best/worst ranking (e.g. priced per 'each' vs per 'pair')
  unitMismatch: boolean
  // false when this offer is excluded from ranking (unit mismatch or missing
  // freight); set during grouping. Defaults true on a standalone row.
  comparable: boolean
  // landed cost per gallon — the apples-to-apples figure used to rank offers.
  // Prices are quoted per gallon, so this equals landedUnitCost.
  pricePerBaseUnit: number
  // landed cost per selling (gallon) unit; retained for location roll-ups
  acquisitionCost: number
  // the date this pricing took effect (from its import, else entry date)
  effectiveDate: string | null
  // canonical matching context
  canonicalItemId: number | null
  matchStatus: string
  canonicalItemName: string | null
}

export type ProductComparison = {
  key: string
  displayName: string
  // kept for backwards compatibility with existing callers
  productId: number
  productName: string
  category: string | null
  unit: string | null
  // true when this group represents a confirmed canonical item spanning
  // potentially multiple vendor products
  isCanonical: boolean
  // base unit used to normalize prices in this group (e.g. 'each', 'litre')
  baseUnit: string | null
  // true when offers in this group have differing pack sizes
  mixedPackSizes: boolean
  // true when one or more offers use a base unit that doesn't match the
  // group's base unit and were therefore excluded from ranking
  hasUnitMismatch: boolean
  // true when one or more FOB offers lack freight (understated cost) and were
  // excluded from ranking because the group has freight-complete offers
  hasIncompleteFreight: boolean
  offers: PriceRow[]
  best: PriceRow | null
  worst: PriceRow | null
  vendorCount: number
  // savings per base unit: worst pricePerBaseUnit - best pricePerBaseUnit
  potentialSavings: number
  // most recent effective date across the group's offers
  latestEffectiveDate: string | null
}

export type LocationComparison = {
  locationId: number | null
  locationName: string
  offerCount: number
  avgLandedUnitCost: number
  totalAcquisitionCost: number
}

async function getAllRows(): Promise<PriceRow[]> {
  const rows = await db
    .select({
      priceId: vendorPrices.id,
      productId: vendorPrices.productId,
      vendorId: vendorPrices.vendorId,
      locationId: vendorPrices.locationId,
      unitPrice: vendorPrices.unitPrice,
      shippingCost: vendorPrices.shippingCost,
      freightEstimated: vendorPrices.freightEstimated,
      freightTerms: vendorPrices.freightTerms,
      deliveredPrice: vendorPrices.deliveredPrice,
      currency: vendorPrices.currency,
      effectiveDate: vendorPrices.effectiveDate,
      createdAt: vendorPrices.createdAt,
      // Per-offer container details, with the product's values as a fallback
      // for any legacy price rows created before these columns existed.
      offerPackSize: vendorPrices.packSize,
      offerBaseUnit: vendorPrices.baseUnit,
      offerSku: vendorPrices.sku,
      productName: products.name,
      category: products.category,
      unit: products.unit,
      packSize: products.packSize,
      baseUnit: products.baseUnit,
      productSku: products.sku,
      canonicalItemId: products.canonicalItemId,
      matchStatus: products.matchStatus,
      canonicalItemName: canonicalItems.name,
      canonicalBaseUnit: canonicalItems.baseUnit,
      vendorName: vendors.name,
      locationName: locations.name,
    })
    .from(vendorPrices)
    .leftJoin(products, eq(products.id, vendorPrices.productId))
    .leftJoin(canonicalItems, eq(canonicalItems.id, products.canonicalItemId))
    .leftJoin(vendors, eq(vendors.id, vendorPrices.vendorId))
    .leftJoin(locations, eq(locations.id, vendorPrices.locationId))

  return rows.map((r) => {
    const unitPrice = Number(r.unitPrice ?? 0)
    const shippingCost = Number(r.shippingCost ?? 0)
    const freightTerms = r.freightTerms ?? 'fob'
    const freightEstimated = Boolean(r.freightEstimated)
    const deliveredPrice =
      r.deliveredPrice !== null && r.deliveredPrice !== undefined
        ? Number(r.deliveredPrice)
        : null

    // Freight is stored per selling unit, so FOB landed cost simply adds it to
    // the unit price — no spreading across the minimum order.
    const fobLandedUnitCost = unitPrice + shippingCost
    // Delivered landed cost is freight-inclusive, so freight is never added.
    // For 'delivered' terms the all-in price lives in unitPrice; for 'both'
    // it lives in deliveredPrice alongside the FOB unitPrice.
    const deliveredLandedUnitCost =
      freightTerms === 'delivered' ? unitPrice : (deliveredPrice ?? Infinity)

    let landedUnitCost: number
    let effectiveBasis: 'fob' | 'delivered'
    if (freightTerms === 'delivered') {
      landedUnitCost = deliveredLandedUnitCost
      effectiveBasis = 'delivered'
    } else if (freightTerms === 'both') {
      // Pick whichever freight arrangement is cheaper per unit.
      if (deliveredLandedUnitCost <= fobLandedUnitCost) {
        landedUnitCost = deliveredLandedUnitCost
        effectiveBasis = 'delivered'
      } else {
        landedUnitCost = fobLandedUnitCost
        effectiveBasis = 'fob'
      }
    } else {
      landedUnitCost = fobLandedUnitCost
      effectiveBasis = 'fob'
    }

    // An FOB offer that arrived with no freight understates the true landed
    // cost: it isn't comparable to delivered offers until freight is supplied.
    const freightIncomplete = effectiveBasis === 'fob' && shippingCost === 0

    const acquisitionCost = landedUnitCost

    // Prices are quoted per gallon, so the landed cost per gallon IS the
    // apples-to-apples figure — we rank on it directly. packSize now carries
    // the physical container capacity (in gallons) for display only and must
    // NOT divide the price.
    // Prefer the per-offer container capacity; fall back to the product's for
    // legacy rows. This keeps multiple container sizes of one product distinct.
    const rawPackSize = Number(r.offerPackSize ?? r.packSize ?? 1)
    const packSize = rawPackSize > 0 ? rawPackSize : 1
    const pricePerBaseUnit = landedUnitCost
    const freightPerBaseUnit = effectiveBasis === 'fob' ? shippingCost : 0

    return {
      priceId: r.priceId,
      productId: r.productId,
      productName: r.productName ?? 'Unknown product',
      category: r.category,
      unit: r.unit,
      sku: r.offerSku ?? r.productSku ?? null,
      vendorId: r.vendorId,
      vendorName: r.vendorName ?? 'Unknown vendor',
      locationId: r.locationId,
      locationName: r.locationName,
      unitPrice,
      shippingCost,
      freightPerBaseUnit,
      freightEstimated,
      freightIncomplete,
      currency: r.currency,
      freightTerms,
      deliveredPrice,
      effectiveBasis,
      landedUnitCost,
      packSize,
      baseUnit: r.offerBaseUnit ?? r.baseUnit ?? r.unit ?? null,
      canonicalBaseUnit: r.canonicalBaseUnit ?? null,
      unitMismatch: false,
      comparable: true,
      pricePerBaseUnit,
      acquisitionCost,
      effectiveDate:
        r.effectiveDate ??
        (r.createdAt
          ? new Date(r.createdAt as unknown as string)
              .toISOString()
              .slice(0, 10)
          : null),
      canonicalItemId: r.canonicalItemId,
      matchStatus: r.matchStatus ?? 'unmatched',
      canonicalItemName: r.canonicalItemName,
    }
  })
}

export async function getProductComparisons(): Promise<ProductComparison[]> {
  await requireUser()
  const rows = await getAllRows()

  // Group offers by their comparison key: products with a confirmed canonical
  // match collapse under that canonical item (so differently-named vendor
  // products compare as one); everything else groups by its own product.
  const byKey = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const key =
      row.matchStatus === 'confirmed' && row.canonicalItemId !== null
        ? `c${row.canonicalItemId}`
        : `p${row.productId}`
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }

  const norm = (u: string | null | undefined) =>
    u?.trim().toLowerCase() || null

  const comparisons: ProductComparison[] = []
  for (const [key, offers] of byKey) {
    const vendorIds = new Set(offers.map((o) => o.vendorId))
    const latestEffectiveDate =
      offers
        .map((o) => o.effectiveDate)
        .filter((d): d is string => !!d)
        .sort()
        .at(-1) ?? null
    const isCanonical = key.startsWith('c')
    const displayName = isCanonical
      ? (offers.find((o) => o.canonicalItemName)?.canonicalItemName ??
        'Canonical item')
      : offers[0].productName

    // The group's base unit anchors comparison. For canonical groups prefer the
    // canonical item's declared base unit; otherwise fall back to the offers'.
    const baseUnit =
      (isCanonical
        ? offers.find((o) => o.canonicalBaseUnit)?.canonicalBaseUnit
        : null) ??
      offers.find((o) => o.baseUnit)?.baseUnit ??
      offers[0].unit ??
      null

    // Flag offers whose own base unit differs from the group's base unit; these
    // can't be compared apples-to-apples (e.g. priced per 'each' vs per 'pair').
    const groupUnit = norm(baseUnit)

    // Only treat missing freight as disqualifying when the group also has at
    // least one freight-complete offer (delivered, or FOB with freight) to
    // compare against. A group of all-FOB-no-freight still ranks among itself.
    const hasFreightComplete = offers.some((o) => !o.freightIncomplete)

    const flagged = offers.map((o) => {
      const unitMismatch =
        !!groupUnit && !!norm(o.baseUnit) && norm(o.baseUnit) !== groupUnit
      const freightExcluded = o.freightIncomplete && hasFreightComplete
      return {
        ...o,
        unitMismatch,
        // not directly comparable for ranking: wrong unit, or understated cost
        comparable: !unitMismatch && !freightExcluded,
      }
    })

    // Rank only comparable offers by normalized per-base-unit cost. Excluded
    // offers still display, but sort after and never win best/worst.
    const comparable = flagged
      .filter((o) => o.comparable)
      .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)
    const excluded = flagged.filter((o) => !o.comparable)
    const offersSorted = [...comparable, ...excluded]
    const best = comparable[0] ?? null
    const worst = comparable[comparable.length - 1] ?? null
    const mixedPackSizes =
      new Set(comparable.map((o) => o.packSize)).size > 1
    const hasUnitMismatch = flagged.some((o) => o.unitMismatch)
    const hasIncompleteFreight = flagged.some(
      (o) => o.freightIncomplete && hasFreightComplete,
    )

    comparisons.push({
      key,
      displayName,
      productId: offers[0].productId,
      productName: displayName,
      category: offers[0].category,
      unit: offers[0].unit,
      isCanonical,
      baseUnit,
      mixedPackSizes,
      hasUnitMismatch,
      hasIncompleteFreight,
      offers: offersSorted,
      best,
      worst,
      vendorCount: vendorIds.size,
      potentialSavings:
        best && worst
          ? worst.pricePerBaseUnit - best.pricePerBaseUnit
          : 0,
      latestEffectiveDate,
    })
  }

  return comparisons.sort((a, b) => b.potentialSavings - a.potentialSavings)
}

export async function getLocationComparisons(): Promise<LocationComparison[]> {
  await requireUser()
  const rows = await getAllRows()

  const byLocation = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const key = row.locationId === null ? 'none' : String(row.locationId)
    const list = byLocation.get(key) ?? []
    list.push(row)
    byLocation.set(key, list)
  }

  const result: LocationComparison[] = []
  for (const [, offers] of byLocation) {
    const totalAcquisitionCost = offers.reduce(
      (sum, o) => sum + o.acquisitionCost,
      0,
    )
    const avgLandedUnitCost =
      offers.reduce((sum, o) => sum + o.landedUnitCost, 0) / offers.length
    result.push({
      locationId: offers[0].locationId,
      locationName: offers[0].locationName ?? 'Unassigned',
      offerCount: offers.length,
      avgLandedUnitCost,
      totalAcquisitionCost,
    })
  }

  return result.sort((a, b) => a.avgLandedUnitCost - b.avgLandedUnitCost)
}

// ----------------------------------------------------------------------------
// Savings opportunity analysis
// ----------------------------------------------------------------------------

export type SavingsOpportunity = {
  key: string
  displayName: string
  category: string | null
  baseUnit: string | null
  vendorCount: number
  bestVendor: string
  worstVendor: string
  bestPerUnit: number
  worstPerUnit: number
  savingsPerUnit: number
  // savings on one container fill of the cheapest offer (per-unit * capacity)
  savingsPerContainer: number
  packSize: number
  currency: string
}

export type VendorAward = {
  vendorId: number
  vendorName: string
  // number of comparable items where this vendor is the cheapest
  itemsWon: number
}

export type SavingsPlan = {
  totalSavingsPerUnit: number
  totalSavingsPerContainer: number
  comparableItems: number
  singleSourceCount: number
  opportunities: SavingsOpportunity[]
  singleSource: {
    key: string
    displayName: string
    category: string | null
    vendorName: string
    perUnit: number
    baseUnit: string | null
    currency: string
  }[]
  awards: VendorAward[]
}

export async function getSavingsPlan(): Promise<SavingsPlan> {
  await requireUser()
  const comparisons = await getProductComparisons()

  const opportunities: SavingsOpportunity[] = []
  const singleSource: SavingsPlan['singleSource'] = []
  const awardMap = new Map<number, VendorAward>()

  for (const c of comparisons) {
    // A vendor "wins" an item only when it beat at least one competitor —
    // winning an uncontested single-source item isn't a real win.
    if (c.best && c.vendorCount > 1) {
      const a = awardMap.get(c.best.vendorId) ?? {
        vendorId: c.best.vendorId,
        vendorName: c.best.vendorName,
        itemsWon: 0,
      }
      a.itemsWon += 1
      awardMap.set(c.best.vendorId, a)
    }

    // Single-source risk: only one vendor quotes this item.
    if (c.vendorCount < 2) {
      if (c.best) {
        singleSource.push({
          key: c.key,
          displayName: c.displayName,
          category: c.category,
          vendorName: c.best.vendorName,
          perUnit: c.best.pricePerBaseUnit,
          baseUnit: c.baseUnit,
          currency: c.best.currency,
        })
      }
      continue
    }

    if (c.best && c.worst && c.potentialSavings > 0) {
      opportunities.push({
        key: c.key,
        displayName: c.displayName,
        category: c.category,
        baseUnit: c.baseUnit,
        vendorCount: c.vendorCount,
        bestVendor: c.best.vendorName,
        worstVendor: c.worst.vendorName,
        bestPerUnit: c.best.pricePerBaseUnit,
        worstPerUnit: c.worst.pricePerBaseUnit,
        savingsPerUnit: c.potentialSavings,
        savingsPerContainer: c.potentialSavings * (c.best.packSize ?? 1),
        packSize: c.best.packSize ?? 1,
        currency: c.best.currency,
      })
    }
  }

  opportunities.sort((a, b) => b.savingsPerContainer - a.savingsPerContainer)

  return {
    totalSavingsPerUnit: opportunities.reduce(
      (s, o) => s + o.savingsPerUnit,
      0,
    ),
    totalSavingsPerContainer: opportunities.reduce(
      (s, o) => s + o.savingsPerContainer,
      0,
    ),
    comparableItems: comparisons.filter((c) => c.vendorCount > 1).length,
    singleSourceCount: singleSource.length,
    opportunities,
    singleSource: singleSource.sort((a, b) => b.perUnit - a.perUnit),
    awards: [...awardMap.values()].sort((a, b) => b.itemsWon - a.itemsWon),
  }
}

// ----------------------------------------------------------------------------
// Price trend over time
// ----------------------------------------------------------------------------

export type TrendPoint = { date: string; pricePerBaseUnit: number }

export type PriceTrend = {
  key: string
  displayName: string
  vendorName: string
  baseUnit: string | null
  currency: string
  points: TrendPoint[]
  latest: number
  previous: number | null
  // percentage change from previous to latest (null when only one data point)
  pctChange: number | null
}

export async function getPriceTrends(): Promise<{
  trends: PriceTrend[]
  dateCount: number
}> {
  await requireUser()
  const rows = await getAllRows()

  // A trend series is one vendor's offers for one comparison group over time.
  const bySeries = new Map<string, PriceRow[]>()
  for (const r of rows) {
    const groupKey =
      r.matchStatus === 'confirmed' && r.canonicalItemId !== null
        ? `c${r.canonicalItemId}`
        : `p${r.productId}`
    const seriesKey = `${groupKey}::${r.vendorId}`
    const list = bySeries.get(seriesKey) ?? []
    list.push(r)
    bySeries.set(seriesKey, list)
  }

  const allDates = new Set<string>()
  const trends: PriceTrend[] = []
  for (const [seriesKey, offers] of bySeries) {
    // Collapse to one point per date (cheapest comparable offer that day).
    const byDate = new Map<string, number>()
    for (const o of offers) {
      const d = o.effectiveDate
      if (!d) continue
      allDates.add(d)
      const prev = byDate.get(d)
      if (prev === undefined || o.pricePerBaseUnit < prev) {
        byDate.set(d, o.pricePerBaseUnit)
      }
    }
    const points = [...byDate.entries()]
      .map(([date, pricePerBaseUnit]) => ({ date, pricePerBaseUnit }))
      .sort((a, b) => a.date.localeCompare(b.date))
    if (points.length === 0) continue

    const sample = offers[0]
    const isCanonical = seriesKey.startsWith('c')
    const displayName = isCanonical
      ? (offers.find((o) => o.canonicalItemName)?.canonicalItemName ??
        sample.productName)
      : sample.productName
    const latest = points[points.length - 1].pricePerBaseUnit
    const previous =
      points.length > 1 ? points[points.length - 2].pricePerBaseUnit : null
    const pctChange =
      previous !== null && previous !== 0
        ? ((latest - previous) / previous) * 100
        : null

    trends.push({
      key: seriesKey,
      displayName,
      vendorName: sample.vendorName,
      baseUnit: sample.baseUnit,
      currency: sample.currency,
      points,
      latest,
      previous,
      pctChange,
    })
  }

  // Series with real movement first, then by magnitude of change.
  trends.sort((a, b) => {
    const am = a.pctChange === null ? -1 : 0
    const bm = b.pctChange === null ? -1 : 0
    if (am !== bm) return bm - am
    return Math.abs(b.pctChange ?? 0) - Math.abs(a.pctChange ?? 0)
  })

  return { trends, dateCount: allDates.size }
}

// ----------------------------------------------------------------------------
// Cross-location comparison
// ----------------------------------------------------------------------------

export type LocationCell = {
  locationId: number | null
  locationName: string
  bestPerUnit: number
  bestVendor: string
}

export type LocationItemRow = {
  key: string
  displayName: string
  category: string | null
  baseUnit: string | null
  currency: string
  cells: LocationCell[]
  // cheapest and dearest location prices for this item
  minPerUnit: number
  maxPerUnit: number
  // spread between locations (arbitrage opportunity), 0 when only one location
  spread: number
  cheapestLocation: string
  dearestLocation: string
}

export async function getLocationMatrix(): Promise<{
  locations: { id: number | null; name: string }[]
  items: LocationItemRow[]
}> {
  await requireUser()
  const rows = await getAllRows()

  const locSet = new Map<string, { id: number | null; name: string }>()
  const byGroup = new Map<string, PriceRow[]>()
  for (const r of rows) {
    const lk = r.locationId === null ? 'none' : String(r.locationId)
    if (!locSet.has(lk)) {
      locSet.set(lk, {
        id: r.locationId,
        name: r.locationName ?? 'Unassigned',
      })
    }
    const groupKey =
      r.matchStatus === 'confirmed' && r.canonicalItemId !== null
        ? `c${r.canonicalItemId}`
        : `p${r.productId}`
    const list = byGroup.get(groupKey) ?? []
    list.push(r)
    byGroup.set(groupKey, list)
  }

  const locations = [...locSet.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const items: LocationItemRow[] = []
  for (const [groupKey, offers] of byGroup) {
    // Best comparable offer per location.
    const byLoc = new Map<string, PriceRow[]>()
    for (const o of offers) {
      const lk = o.locationId === null ? 'none' : String(o.locationId)
      const list = byLoc.get(lk) ?? []
      list.push(o)
      byLoc.set(lk, list)
    }

    const cells: LocationCell[] = []
    for (const [lk, locOffers] of byLoc) {
      const comparable = locOffers
        .filter((o) => o.comparable)
        .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)
      const best = comparable[0]
      if (!best) continue
      cells.push({
        locationId: best.locationId,
        locationName: best.locationName ?? 'Unassigned',
        bestPerUnit: best.pricePerBaseUnit,
        bestVendor: best.vendorName,
      })
    }
    if (cells.length === 0) continue

    const sample = offers[0]
    const isCanonical = groupKey.startsWith('c')
    const displayName = isCanonical
      ? (offers.find((o) => o.canonicalItemName)?.canonicalItemName ??
        sample.productName)
      : sample.productName

    const sorted = [...cells].sort((a, b) => a.bestPerUnit - b.bestPerUnit)
    const min = sorted[0]
    const max = sorted[sorted.length - 1]

    items.push({
      key: groupKey,
      displayName,
      category: sample.category,
      baseUnit: sample.baseUnit,
      currency: sample.currency,
      cells,
      minPerUnit: min.bestPerUnit,
      maxPerUnit: max.bestPerUnit,
      spread: max.bestPerUnit - min.bestPerUnit,
      cheapestLocation: min.locationName,
      dearestLocation: max.locationName,
    })
  }

  // Biggest cross-location spread (arbitrage) first.
  items.sort((a, b) => b.spread - a.spread)

  return { locations, items }
}

export async function getDashboardStats() {
  await requireUser()
  const rows = await getAllRows()
  const productIds = new Set(rows.map((r) => r.productId))
  const vendorIds = new Set(rows.map((r) => r.vendorId))

  const comparisons = await getProductComparisons()
  // potentialSavings is per gallon; scale by the cheapest offer's container
  // capacity (gallons) to approximate the saving on one container fill.
  const totalPotentialSavings = comparisons.reduce(
    (sum, c) => sum + c.potentialSavings * (c.best?.packSize ?? 1),
    0,
  )

  return {
    productCount: productIds.size,
    vendorCount: vendorIds.size,
    offerCount: rows.length,
    comparableProducts: comparisons.filter((c) => c.vendorCount > 1).length,
    totalPotentialSavings,
  }
}
