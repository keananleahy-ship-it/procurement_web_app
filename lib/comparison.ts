import 'server-only'

import { db } from '@/lib/db'
import {
  locations,
  products,
  purchaseVolumes,
  vendorPrices,
  vendors,
} from '@/lib/db/schema'
import {
  comparisonKey,
  DEFAULT_TIGHTNESS,
  groupLabel,
  type ProductTraits,
  type Tightness,
} from '@/lib/traits'
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
  application: string | null
  subcategory: string | null
  viscosity: string | null
  brand: string | null
  performanceSpec: string | null
  unit: string | null
  vendorId: number
  vendorName: string
  locationId: number | null
  locationName: string | null
  region: string | null
  // unit price PER SELLING UNIT ('base' quotes are scaled up by packSize)
  unitPrice: number
  priceBasis: string
  shippingCost: number
  freightPerBaseUnit: number
  freightEstimated: boolean
  // FOB offer with no freight supplied: understated cost
  freightIncomplete: boolean
  minOrderQty: number
  currency: string
  freightTerms: string
  deliveredPrice: number | null
  effectiveBasis: 'fob' | 'delivered'
  landedUnitCost: number
  packSize: number
  baseUnit: string | null
  // offer's base unit differs from its group's and can't be ranked
  unitMismatch: boolean
  comparable: boolean
  pricePerBaseUnit: number
  // pricePerBaseUnit in the group's base unit (differs only for gear oils)
  comparablePricePerBaseUnit: number
  unitConverted: boolean
  acquisitionCost: number
  effectiveDate: string | null
}

export type VolumeByLocation = {
  locationId: number | null
  locationName: string
  annualVolume: number
  realizableSavings: number
}

export type ProductComparison = {
  key: string
  // Trait group key (shared by every product in the group). Products that
  // can't be keyed under the current tightness form a single-product group
  // keyed "p{productId}" and have isGroup = false.
  groupKey: string
  isGroup: boolean
  displayName: string
  productId: number
  productName: string
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
  unit: string | null
  baseUnit: string | null
  mixedPackSizes: boolean
  hasUnitMismatch: boolean
  hasIncompleteFreight: boolean
  offers: PriceRow[]
  best: PriceRow | null
  worst: PriceRow | null
  vendorCount: number
  productCount: number
  potentialSavings: number
  annualVolume: number
  realizableSavings: number
  volumeByLocation: VolumeByLocation[]
  latestEffectiveDate: string | null
}

export type LocationVolume = {
  annualVolume: number
  // volume-weighted average paid cost per base unit, or null when unknown
  baselineUnitCost: number | null
  baseUnit: string | null
}

export type VolumeMaps = {
  // productId -> location -> volume
  byProduct: Map<number, Map<number | null, LocationVolume>>
  // groupKey -> location -> volume (collapses product identity)
  byGroup: Map<string, Map<number | null, LocationVolume>>
  // groupKey -> productId -> location -> volume
  byGroupProduct: Map<string, Map<number, Map<number | null, LocationVolume>>>
  locationNames: Map<number | null, string>
  productNames: Map<number, string>
  // volume rows with no product, so no characteristics can be read
  unlinked: { annualVolume: number; rows: number }
  total: number
}

type TraitSource = {
  category: string | null
  viscosity: string | null
  subcategory: string | null
  performanceSpec: string | null
  brand: string | null
  packSize: string | number | null
  baseUnit: string | null
}

export function traitsOf(p: TraitSource): ProductTraits {
  const size = p.packSize == null ? null : Number(p.packSize)
  return {
    category: p.category,
    viscosity: p.viscosity,
    formulation: p.subcategory,
    spec: p.performanceSpec,
    brand: p.brand,
    packSize: size != null && Number.isFinite(size) && size > 0 ? size : null,
    baseUnit: p.baseUnit,
  }
}

export function groupKeyFor(
  productId: number,
  traits: ProductTraits,
  tightness: Tightness,
): string {
  return comparisonKey(traits, tightness) ?? `p${productId}`
}

// Shared workspace: not filtered by userId.
export async function getAllRows(): Promise<
  (PriceRow & { traits: ProductTraits })[]
> {
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
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
      brand: products.brand,
      performanceSpec: products.performanceSpec,
      unit: products.unit,
      packSize: products.packSize,
      baseUnit: products.baseUnit,
      matchStatus: products.matchStatus,
      vendorName: vendors.name,
      locationName: locations.name,
      region: locations.region,
    })
    .from(vendorPrices)
    .leftJoin(products, eq(products.id, vendorPrices.productId))
    .leftJoin(vendors, eq(vendors.id, vendorPrices.vendorId))
    .leftJoin(locations, eq(locations.id, vendorPrices.locationId))

  return (
    rows
      // 'excluded' is a reviewer relevance flag (e.g. OEM-only product).
      .filter((r) => r.matchStatus !== 'excluded')
      .map((r) => {
        const rawPackSize = Number(r.packSize ?? 1)
        const packSize = rawPackSize > 0 ? rawPackSize : 1
        const isPerBaseUnit = isPerBaseUnitPrice({
          unit: r.unit,
          baseUnit: r.baseUnit,
          storedBasis: r.priceBasis,
        })
        // Per-base quotes are scaled up to per-selling-unit so freight and
        // landed-cost math stays consistent; dividing by packSize recovers it.
        const priceScale = isPerBaseUnit ? packSize : 1
        const unitPrice = Number(r.unitPrice ?? 0) * priceScale
        const shippingCost = Number(r.shippingCost ?? 0) * priceScale
        const minOrderQty = Number(r.minOrderQty ?? 1) || 1
        const freightTerms = r.freightTerms ?? 'fob'
        const deliveredPrice =
          r.deliveredPrice != null ? Number(r.deliveredPrice) * priceScale : null

        const fob = unitPrice + shippingCost
        const delivered =
          freightTerms === 'delivered' ? unitPrice : (deliveredPrice ?? Infinity)
        let landedUnitCost = fob
        let effectiveBasis: 'fob' | 'delivered' = 'fob'
        if (
          freightTerms === 'delivered' ||
          (freightTerms === 'both' && delivered <= fob)
        ) {
          landedUnitCost = delivered
          effectiveBasis = 'delivered'
        }
        const pricePerBaseUnit = landedUnitCost / packSize

        return {
          priceId: r.priceId,
          productId: r.productId,
          productName: r.productName ?? 'Unknown product',
          category: r.category,
          application: r.application,
          subcategory: r.subcategory,
          viscosity: r.viscosity,
          brand: r.brand,
          performanceSpec: r.performanceSpec,
          unit: r.unit,
          vendorId: r.vendorId,
          vendorName: r.vendorName ?? 'Unknown vendor',
          locationId: r.locationId,
          locationName: r.locationName,
          region: r.region,
          unitPrice,
          priceBasis: isPerBaseUnit ? 'base' : 'pack',
          shippingCost,
          freightPerBaseUnit:
            effectiveBasis === 'fob' ? shippingCost / packSize : 0,
          freightEstimated: Boolean(r.freightEstimated),
          freightIncomplete: effectiveBasis === 'fob' && shippingCost === 0,
          minOrderQty,
          currency: r.currency,
          freightTerms,
          deliveredPrice,
          effectiveBasis,
          landedUnitCost,
          packSize,
          baseUnit: r.baseUnit ?? r.unit ?? null,
          unitMismatch: false,
          comparable: true,
          pricePerBaseUnit,
          comparablePricePerBaseUnit: pricePerBaseUnit,
          unitConverted: false,
          acquisitionCost: landedUnitCost * minOrderQty,
          effectiveDate:
            r.effectiveDate ??
            (r.createdAt
              ? new Date(r.createdAt as unknown as string)
                  .toISOString()
                  .slice(0, 10)
              : null),
          traits: traitsOf(r),
        }
      })
  )
}

function accumulate(
  perLoc: Map<number | null, LocationVolume>,
  locationId: number | null,
  vol: number,
  cost: number | null,
  baseUnit: string | null,
) {
  const prev = perLoc.get(locationId) ?? {
    annualVolume: 0,
    baselineUnitCost: null,
    baseUnit,
  }
  let baselineUnitCost = prev.baselineUnitCost
  if (cost !== null && Number.isFinite(cost) && cost > 0) {
    baselineUnitCost =
      prev.baselineUnitCost === null
        ? cost
        : (prev.baselineUnitCost * prev.annualVolume + cost * vol) /
          (prev.annualVolume + vol)
  }
  perLoc.set(locationId, {
    annualVolume: prev.annualVolume + vol,
    baselineUnitCost,
    baseUnit: prev.baseUnit ?? baseUnit,
  })
}

export async function loadVolumeMaps(
  tightness: Tightness = DEFAULT_TIGHTNESS,
): Promise<VolumeMaps> {
  const rows = await db
    .select({
      productId: purchaseVolumes.productId,
      locationId: purchaseVolumes.locationId,
      annualVolume: purchaseVolumes.annualVolume,
      baselineUnitCost: purchaseVolumes.baselineUnitCost,
      baseUnit: purchaseVolumes.baseUnit,
      locationName: locations.name,
      productName: products.name,
      category: products.category,
      viscosity: products.viscosity,
      subcategory: products.subcategory,
      performanceSpec: products.performanceSpec,
      brand: products.brand,
      packSize: products.packSize,
      productBaseUnit: products.baseUnit,
    })
    .from(purchaseVolumes)
    .leftJoin(locations, eq(locations.id, purchaseVolumes.locationId))
    .leftJoin(products, eq(products.id, purchaseVolumes.productId))

  const maps: VolumeMaps = {
    byProduct: new Map(),
    byGroup: new Map(),
    byGroupProduct: new Map(),
    locationNames: new Map(),
    productNames: new Map(),
    unlinked: { annualVolume: 0, rows: 0 },
    total: 0,
  }

  for (const r of rows) {
    const vol = Number(r.annualVolume ?? 0)
    if (!Number.isFinite(vol) || vol <= 0) continue
    maps.total += vol
    maps.locationNames.set(r.locationId, r.locationName ?? 'Unassigned')
    if (r.productId === null || !r.productName) {
      maps.unlinked.annualVolume += vol
      maps.unlinked.rows++
      continue
    }
    maps.productNames.set(r.productId, r.productName)
    const cost = r.baselineUnitCost != null ? Number(r.baselineUnitCost) : null
    const unit = r.baseUnit ?? null

    const perProd = maps.byProduct.get(r.productId) ?? new Map()
    accumulate(perProd, r.locationId, vol, cost, unit)
    maps.byProduct.set(r.productId, perProd)

    const gk = groupKeyFor(
      r.productId,
      traitsOf({ ...r, baseUnit: r.productBaseUnit }),
      tightness,
    )
    const perGroup = maps.byGroup.get(gk) ?? new Map()
    accumulate(perGroup, r.locationId, vol, cost, unit)
    maps.byGroup.set(gk, perGroup)

    const byProd = maps.byGroupProduct.get(gk) ?? new Map()
    const prodLoc = byProd.get(r.productId) ?? new Map()
    accumulate(prodLoc, r.locationId, vol, cost, unit)
    byProd.set(r.productId, prodLoc)
    maps.byGroupProduct.set(gk, byProd)
  }
  return maps
}

// Rank offers in one group: flag unit mismatches (converting gear oils across
// lb/gal), exclude freight-incomplete FOB offers when complete ones exist.
export function rankOffers(offers: PriceRow[], displayName: string) {
  const baseUnit =
    offers.find((o) => o.baseUnit)?.baseUnit ?? offers[0]?.unit ?? null
  const groupUnit = normalizeUom(baseUnit)
  const effectiveOfferUnit = (o: PriceRow) =>
    !isMeasureUom(o.baseUnit) && isMeasureUom(o.unit)
      ? normalizeUom(o.unit)
      : normalizeUom(o.baseUnit)
  const isGearOil = isGearOilName(
    displayName,
    ...offers.map((o) => o.productName),
  )
  const hasFreightComplete = offers.some((o) => !o.freightIncomplete)

  const flagged = offers.map((o) => {
    const offerUnit = effectiveOfferUnit(o)
    let unitMismatch = !!groupUnit && !!offerUnit && offerUnit !== groupUnit
    let comparablePricePerBaseUnit = o.pricePerBaseUnit
    let unitConverted = false
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
      comparable: !unitMismatch && !freightExcluded,
    }
  })
  const comparable = flagged
    .filter((o) => o.comparable)
    .sort((a, b) => a.comparablePricePerBaseUnit - b.comparablePricePerBaseUnit)
  const excluded = flagged.filter((o) => !o.comparable)
  return {
    baseUnit,
    groupUnit,
    offers: [...comparable, ...excluded],
    comparable,
    hasUnitMismatch: flagged.some((o) => o.unitMismatch),
    hasIncompleteFreight: flagged.some(
      (o) => o.freightIncomplete && hasFreightComplete,
    ),
  }
}

function stripTraits<T extends { traits: ProductTraits }>(
  r: T,
): Omit<T, 'traits'> {
  const { traits: _traits, ...rest } = r
  return rest
}

export async function buildComparisons(
  tightness: Tightness = DEFAULT_TIGHTNESS,
): Promise<ProductComparison[]> {
  const [rows, volumes] = await Promise.all([
    getAllRows(),
    loadVolumeMaps(tightness),
  ])

  const byKey = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const key = groupKeyFor(row.productId, row.traits, tightness)
    const list = byKey.get(key) ?? []
    list.push(stripTraits(row))
    byKey.set(key, list)
  }

  const comparisons: ProductComparison[] = []
  for (const [key, groupOffers] of byKey) {
    const isGroup = !key.startsWith('p')
    const productIds = new Set(groupOffers.map((o) => o.productId))
    const displayName =
      isGroup && productIds.size > 1
        ? groupLabel(key)
        : groupOffers[0].productName
    const ranked = rankOffers(groupOffers, displayName)
    const best = ranked.comparable[0] ?? null
    const worst = ranked.comparable.at(-1) ?? null
    const potentialSavings =
      best && worst
        ? worst.comparablePricePerBaseUnit - best.comparablePricePerBaseUnit
        : 0

    const perLoc = isGroup
      ? volumes.byGroup.get(key)
      : volumes.byProduct.get(groupOffers[0].productId)
    const bestPer = best?.comparablePricePerBaseUnit ?? null
    const savingsPerUnitFor = (v: LocationVolume) => {
      if (
        bestPer !== null &&
        v.baselineUnitCost !== null &&
        (!v.baseUnit ||
          !ranked.groupUnit ||
          normalizeUom(v.baseUnit) === ranked.groupUnit)
      ) {
        return Math.max(0, v.baselineUnitCost - bestPer)
      }
      return potentialSavings
    }
    const volumeByLocation: VolumeByLocation[] = perLoc
      ? [...perLoc.entries()].map(([locationId, lv]) => ({
          locationId,
          locationName: volumes.locationNames.get(locationId) ?? 'Unassigned',
          annualVolume: lv.annualVolume,
          realizableSavings: savingsPerUnitFor(lv) * lv.annualVolume,
        }))
      : []

    comparisons.push({
      key,
      groupKey: key,
      isGroup,
      displayName,
      productId: groupOffers[0].productId,
      productName: displayName,
      category: groupOffers[0].category,
      application: groupOffers[0].application,
      subcategory: groupOffers[0].subcategory,
      viscosity: groupOffers[0].viscosity,
      unit: groupOffers[0].unit,
      baseUnit: ranked.baseUnit,
      mixedPackSizes:
        new Set(ranked.comparable.map((o) => o.packSize)).size > 1,
      hasUnitMismatch: ranked.hasUnitMismatch,
      hasIncompleteFreight: ranked.hasIncompleteFreight,
      offers: ranked.offers,
      best,
      worst,
      vendorCount: new Set(groupOffers.map((o) => o.vendorId)).size,
      productCount: productIds.size,
      potentialSavings,
      annualVolume: volumeByLocation.reduce((s, v) => s + v.annualVolume, 0),
      realizableSavings: volumeByLocation.reduce(
        (s, v) => s + v.realizableSavings,
        0,
      ),
      volumeByLocation,
      latestEffectiveDate:
        groupOffers
          .map((o) => o.effectiveDate)
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? null,
    })
  }

  const hasAnyVolume = comparisons.some((c) => c.annualVolume > 0)
  return comparisons.sort((a, b) =>
    hasAnyVolume
      ? b.realizableSavings - a.realizableSavings
      : b.potentialSavings - a.potentialSavings,
  )
}
