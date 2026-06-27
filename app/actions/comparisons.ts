'use server'

import { db } from '@/lib/db'
import {
  canonicalItems,
  locations,
  products,
  purchaseVolumes,
  vendorPrices,
  vendors,
} from '@/lib/db/schema'
import { requireUser } from '@/lib/roles'
import {
  GEAR_OIL_LB_PER_GAL,
  isGearOilName,
  isMeasureUom,
  isPerBaseUnitPrice,
  normalizeUom,
  pricePerUnitFactor,
} from '@/lib/uom'
import { eq } from 'drizzle-orm'

export type PriceRow = {
  priceId: number
  productId: number
  productName: string
  category: string | null
  unit: string | null
  vendorId: number
  vendorName: string
  locationId: number | null
  locationName: string | null
  // unit price expressed PER SELLING UNIT. For 'base'-basis quotes (e.g.
  // $/gallon) the stored per-base figure is scaled up by packSize so all the
  // per-selling-unit math below stays consistent.
  unitPrice: number
  // 'pack' = quoted per selling unit; 'base' = quoted per base unit ($/gal)
  priceBasis: string
  // inbound freight per selling unit applied to the landed cost below
  shippingCost: number
  // freight per base unit (shippingCost / packSize), for the freight column
  freightPerBaseUnit: number
  // true when shippingCost is a user-supplied estimate, not a quoted figure
  freightEstimated: boolean
  // true when this is an FOB offer with no freight supplied, so its landed
  // cost understates the true delivered cost and it can't be ranked fairly
  freightIncomplete: boolean
  minOrderQty: number
  currency: string
  // freight basis: 'fob' | 'delivered' | 'both'
  freightTerms: string
  deliveredPrice: number | null
  // which basis was used to compute the landed cost below ('fob' | 'delivered')
  effectiveBasis: 'fob' | 'delivered'
  // landed cost per SELLING unit, freight-adjusted for the basis above
  landedUnitCost: number
  // base units contained in one selling unit (e.g. box of 100 => 100)
  packSize: number
  // this offer's own base unit of measure (e.g. 'each', 'litre')
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
  // landed cost per BASE unit = landedUnitCost / packSize, in THIS offer's own
  // base unit. Shown as the vendor's native figure.
  pricePerBaseUnit: number
  // pricePerBaseUnit expressed in the GROUP's base unit — identical to
  // pricePerBaseUnit unless a unit conversion was applied (gear oils only).
  // This is the value used to rank offers and compute savings.
  comparablePricePerBaseUnit: number
  // true when pricePerBaseUnit was converted into the group's base unit (e.g. a
  // gear oil quoted per pound normalized to per gallon). Set during grouping.
  unitConverted: boolean
  // total acquisition cost to fulfill the minimum order
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
  // total annual purchase volume for this group across locations, in base
  // units (0 when no volume data is on file). This is the multiplier that
  // turns a per-unit price gap into a real dollar opportunity.
  annualVolume: number
  // annualized dollar opportunity = potentialSavings * annualVolume
  realizableSavings: number
  // per-location volume + annualized savings, so opportunities can be read by
  // site (empty when no volume data exists for this group)
  volumeByLocation: VolumeByLocation[]
  // most recent effective date across the group's offers
  latestEffectiveDate: string | null
}

export type VolumeByLocation = {
  locationId: number | null
  locationName: string
  annualVolume: number
  realizableSavings: number
}

export type LocationComparison = {
  locationId: number | null
  locationName: string
  offerCount: number
  avgLandedUnitCost: number
  totalAcquisitionCost: number
  // total annual purchase volume bought at this location (base units/year)
  annualVolume: number
  // annualized savings attributable to this location's volume
  realizableSavings: number
}

async function getAllRows(): Promise<PriceRow[]> {
  const rows = await db
    .select({
      priceId: vendorPrices.id,
      productId: vendorPrices.productId,
      vendorId: vendorPrices.vendorId,
      locationId: vendorPrices.locationId,
      unitPrice: vendorPrices.unitPrice,
      priceBasis: vendorPrices.priceBasis,
      shippingCost: vendorPrices.shippingCost,
      freightEstimated: vendorPrices.freightEstimated,
      freightTerms: vendorPrices.freightTerms,
      deliveredPrice: vendorPrices.deliveredPrice,
      minOrderQty: vendorPrices.minOrderQty,
      currency: vendorPrices.currency,
      effectiveDate: vendorPrices.effectiveDate,
      createdAt: vendorPrices.createdAt,
      productName: products.name,
      category: products.category,
      unit: products.unit,
      packSize: products.packSize,
      baseUnit: products.baseUnit,
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

  return rows
    // Products a reviewer rule marked irrelevant are dropped from comparison.
    .filter((r) => r.matchStatus !== 'excluded')
    .map((r) => {
    const rawPackSize = Number(r.packSize ?? 1)
    const packSize = rawPackSize > 0 ? rawPackSize : 1

    // Decide whether the quoted price is already per BASE UNIT (e.g. $/gallon)
    // and so must NOT be divided by pack size. The shared helper handles the
    // two cases that matter across vendors:
    //   - "gal" vs "USG" spelling differences both normalize to gallon, so a
    //     per-gallon quote stays per-gallon (fixes ALS-style rows divided by
    //     ~275), and
    //   - a count unit like "each" is NOT a measure, so a 12-pack of filters
    //     priced "each" is treated as a per-case price and IS divided (fixes
    //     Shell-style rows that were wrongly shown per-case).
    // An explicit priceBasis === 'base' (AI extraction or reviewer override)
    // always wins.
    const isPerBaseUnit = isPerBaseUnitPrice({
      unit: r.unit,
      baseUnit: r.baseUnit,
      storedBasis: r.priceBasis,
    })
    const priceBasis = isPerBaseUnit ? 'base' : 'pack'

    // A per-base quote is scaled UP to a per-SELLING-UNIT price so the freight /
    // min-order / landed-cost math below (all per selling unit) stays correct;
    // dividing by packSize afterwards then recovers the original per-base-unit
    // figure WITHOUT dividing it a second time. A 'pack' quote is already per
    // selling unit, so it is used as-is.
    const priceScale = isPerBaseUnit ? packSize : 1

    const unitPrice = Number(r.unitPrice ?? 0) * priceScale
    // Freight shares the price's basis: a per-base ($/gal) quote carries per-base
    // freight, so scale it up too and it divides back cleanly per base unit.
    const shippingCost = Number(r.shippingCost ?? 0) * priceScale
    const minOrderQty = Number(r.minOrderQty ?? 1) || 1
    const freightTerms = r.freightTerms ?? 'fob'
    const freightEstimated = Boolean(r.freightEstimated)
    const deliveredPrice =
      r.deliveredPrice !== null && r.deliveredPrice !== undefined
        ? Number(r.deliveredPrice) * priceScale
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

    const acquisitionCost = landedUnitCost * minOrderQty

    // Normalize to a per-base-unit cost so different pack sizes (e.g. a box of
    // 100 vs a single each) compare fairly. For 'base' quotes the price was
    // scaled up by packSize above, so this division returns the original
    // per-base-unit price rather than dividing it twice.
    const pricePerBaseUnit = landedUnitCost / packSize
    const freightPerBaseUnit =
      effectiveBasis === 'fob' ? shippingCost / packSize : 0

    return {
      priceId: r.priceId,
      productId: r.productId,
      productName: r.productName ?? 'Unknown product',
      category: r.category,
      unit: r.unit,
      vendorId: r.vendorId,
      vendorName: r.vendorName ?? 'Unknown vendor',
      locationId: r.locationId,
      locationName: r.locationName,
      unitPrice,
      priceBasis,
      shippingCost,
      freightPerBaseUnit,
      freightEstimated,
      freightIncomplete,
      minOrderQty,
      currency: r.currency,
      freightTerms,
      deliveredPrice,
      effectiveBasis,
      landedUnitCost,
      packSize,
      baseUnit: r.baseUnit ?? r.unit ?? null,
      canonicalBaseUnit: r.canonicalBaseUnit ?? null,
      unitMismatch: false,
      comparable: true,
      pricePerBaseUnit,
      // default: comparable figure equals the native one; grouping overrides
      // this for gear oils that need cross-unit normalization.
      comparablePricePerBaseUnit: pricePerBaseUnit,
      unitConverted: false,
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

// Loads annual purchase volume keyed both by canonical item and by product,
// each broken down per location. Comparison groups look these up to weight
// their per-unit savings into real annualized dollars.
type VolumeMaps = {
  byCanonical: Map<number, Map<number | null, number>>
  byProduct: Map<number, Map<number | null, number>>
  locationNames: Map<number | null, string>
  total: number
}

// Note: like getAllRows, this is a shared workspace and is NOT filtered by
// userId — every signed-in user sees the same comparison and volume data.
async function loadVolumeMaps(): Promise<VolumeMaps> {
  const rows = await db
    .select({
      canonicalItemId: purchaseVolumes.canonicalItemId,
      productId: purchaseVolumes.productId,
      locationId: purchaseVolumes.locationId,
      annualVolume: purchaseVolumes.annualVolume,
      locationName: locations.name,
    })
    .from(purchaseVolumes)
    .leftJoin(locations, eq(locations.id, purchaseVolumes.locationId))

  const byCanonical = new Map<number, Map<number | null, number>>()
  const byProduct = new Map<number, Map<number | null, number>>()
  const locationNames = new Map<number | null, string>()
  let total = 0

  for (const r of rows) {
    const vol = Number(r.annualVolume ?? 0)
    if (!Number.isFinite(vol) || vol <= 0) continue
    total += vol
    locationNames.set(r.locationId, r.locationName ?? 'Unassigned')
    const target = r.canonicalItemId !== null ? byCanonical : byProduct
    const id = r.canonicalItemId ?? r.productId
    if (id === null) continue
    const perLoc = target.get(id) ?? new Map<number | null, number>()
    perLoc.set(r.locationId, (perLoc.get(r.locationId) ?? 0) + vol)
    target.set(id, perLoc)
  }

  return { byCanonical, byProduct, locationNames, total }
}

export async function getProductComparisons(): Promise<ProductComparison[]> {
  await requireUser()
  const rows = await getAllRows()
  const volumes = await loadVolumeMaps()

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
    // Use the canonical UOM normalizer (not a bare lowercase) so spelling
    // variants of the same measure agree — e.g. a group quoted in "USG" and an
    // offer in "gal" are both "gallon" and must NOT be treated as a mismatch.
    const groupUnit = normalizeUom(baseUnit)

    // An offer's effective comparison unit. When its stored base unit is a
    // count/container word (e.g. "each") but the price is quoted per a real
    // measure (e.g. "gal"), pricePerBaseUnit is already expressed in that
    // measure (see isPerBaseUnitPrice), so we compare on the pricing unit
    // rather than the placeholder base unit. This is what was wrongly flagging
    // bulk oils stored as "each" but actually priced per gallon.
    const effectiveOfferUnit = (o: (typeof offers)[number]) =>
      !isMeasureUom(o.baseUnit) && isMeasureUom(o.unit)
        ? normalizeUom(o.unit)
        : normalizeUom(o.baseUnit)

    // Gear oils are quoted per pound by some vendors and per gallon by others,
    // so for these groups we normalize differing units into the group's base
    // unit (using gear-oil density to bridge weight<->volume) rather than
    // excluding them. Grease and everything else are untouched: grease is
    // consistently per pound, and isGearOilName explicitly excludes it.
    const isGearOil = isGearOilName(
      displayName,
      ...offers.map((o) => o.productName),
    )

    // Only treat missing freight as disqualifying when the group also has at
    // least one freight-complete offer (delivered, or FOB with freight) to
    // compare against. A group of all-FOB-no-freight still ranks among itself.
    const hasFreightComplete = offers.some((o) => !o.freightIncomplete)

    const flagged = offers.map((o) => {
      const offerUnit = effectiveOfferUnit(o)
      let unitMismatch =
        !!groupUnit && !!offerUnit && offerUnit !== groupUnit
      let comparablePricePerBaseUnit = o.pricePerBaseUnit
      let unitConverted = false

      // For gear oils, try to convert a differing unit into the group's base
      // unit so it ranks alongside the rest instead of being excluded.
      if (unitMismatch && isGearOil) {
        const factor = pricePerUnitFactor(o.baseUnit, baseUnit, {
          lbPerGal: GEAR_OIL_LB_PER_GAL,
        })
        if (factor !== null) {
          comparablePricePerBaseUnit = o.pricePerBaseUnit * factor
          unitConverted = true
          unitMismatch = false
        }
      }

      const freightExcluded = o.freightIncomplete && hasFreightComplete
      return {
        ...o,
        unitMismatch,
        unitConverted,
        comparablePricePerBaseUnit,
        // not directly comparable for ranking: wrong unit, or understated cost
        comparable: !unitMismatch && !freightExcluded,
      }
    })

    // Rank only comparable offers by normalized per-base-unit cost (which for
    // gear oils may be a converted figure). Excluded offers still display, but
    // sort after and never win best/worst.
    const comparable = flagged
      .filter((o) => o.comparable)
      .sort(
        (a, b) => a.comparablePricePerBaseUnit - b.comparablePricePerBaseUnit,
      )
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

    const potentialSavings =
      best && worst
        ? worst.comparablePricePerBaseUnit - best.comparablePricePerBaseUnit
        : 0

    // Look up this group's volume: canonical groups (key 'c…') by canonical id,
    // standalone products (key 'p…') by product id.
    const perLoc = isCanonical
      ? volumes.byCanonical.get(Number(key.slice(1)))
      : volumes.byProduct.get(offers[0].productId)
    const volumeByLocation: VolumeByLocation[] = perLoc
      ? [...perLoc.entries()].map(([locationId, annualVolume]) => ({
          locationId,
          locationName: volumes.locationNames.get(locationId) ?? 'Unassigned',
          annualVolume,
          realizableSavings: potentialSavings * annualVolume,
        }))
      : []
    const annualVolume = volumeByLocation.reduce(
      (sum, v) => sum + v.annualVolume,
      0,
    )
    const realizableSavings = potentialSavings * annualVolume

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
      potentialSavings,
      annualVolume,
      realizableSavings,
      volumeByLocation,
      latestEffectiveDate,
    })
  }

  // Rank by the real annualized dollar opportunity when any volume is known,
  // otherwise fall back to the per-unit gap so installs without volume data
  // still see a sensible ordering.
  const hasAnyVolume = comparisons.some((c) => c.annualVolume > 0)
  return comparisons.sort((a, b) =>
    hasAnyVolume
      ? b.realizableSavings - a.realizableSavings
      : b.potentialSavings - a.potentialSavings,
  )
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

  // Roll up annual volume and annualized savings per location from the
  // comparison groups, so each site shows the dollars its volume unlocks.
  const comparisons = await getProductComparisons()
  const volumeByLoc = new Map<
    string,
    { annualVolume: number; realizableSavings: number }
  >()
  for (const c of comparisons) {
    for (const v of c.volumeByLocation) {
      const key = v.locationId === null ? 'none' : String(v.locationId)
      const acc = volumeByLoc.get(key) ?? {
        annualVolume: 0,
        realizableSavings: 0,
      }
      acc.annualVolume += v.annualVolume
      acc.realizableSavings += v.realizableSavings
      volumeByLoc.set(key, acc)
    }
  }

  const result: LocationComparison[] = []
  for (const [locKey, offers] of byLocation) {
    const totalAcquisitionCost = offers.reduce(
      (sum, o) => sum + o.acquisitionCost,
      0,
    )
    const avgLandedUnitCost =
      offers.reduce((sum, o) => sum + o.landedUnitCost, 0) / offers.length
    const vol = volumeByLoc.get(locKey) ?? {
      annualVolume: 0,
      realizableSavings: 0,
    }
    result.push({
      locationId: offers[0].locationId,
      locationName: offers[0].locationName ?? 'Unassigned',
      offerCount: offers.length,
      avgLandedUnitCost,
      totalAcquisitionCost,
      annualVolume: vol.annualVolume,
      realizableSavings: vol.realizableSavings,
    })
  }

  return result.sort((a, b) => a.avgLandedUnitCost - b.avgLandedUnitCost)
}

export async function getDashboardStats() {
  await requireUser()
  const rows = await getAllRows()
  const productIds = new Set(rows.map((r) => r.productId))
  const vendorIds = new Set(rows.map((r) => r.vendorId))

  const comparisons = await getProductComparisons()

  // When purchase volumes are on file, the headline is the real annualized
  // opportunity: per-unit savings * annual volume, summed across groups.
  const hasVolume = comparisons.some((c) => c.annualVolume > 0)
  const totalRealizableSavings = comparisons.reduce(
    (sum, c) => sum + c.realizableSavings,
    0,
  )
  // Fallback for installs with no volume data: scale the per-unit gap by the
  // base units in one minimum order (packSize * minOrderQty) of the best offer.
  const totalMinOrderSavings = comparisons.reduce(
    (sum, c) =>
      sum +
      c.potentialSavings *
        ((c.best?.packSize ?? 1) * (c.best?.minOrderQty ?? 1)),
    0,
  )

  const totalAnnualVolume = comparisons.reduce(
    (sum, c) => sum + c.annualVolume,
    0,
  )

  return {
    productCount: productIds.size,
    vendorCount: vendorIds.size,
    offerCount: rows.length,
    comparableProducts: comparisons.filter((c) => c.vendorCount > 1).length,
    totalPotentialSavings: hasVolume
      ? totalRealizableSavings
      : totalMinOrderSavings,
    // true when the savings figure is volume-weighted (vs the min-order proxy)
    savingsAreVolumeWeighted: hasVolume,
    // total annual purchase volume across all groups (base units/year)
    totalAnnualVolume,
  }
}
