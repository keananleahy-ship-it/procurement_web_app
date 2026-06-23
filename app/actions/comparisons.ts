'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  canonicalItems,
  locations,
  products,
  vendorPrices,
  vendors,
} from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

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
  unitPrice: number
  shippingCost: number
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
  // landed cost per BASE unit = landedUnitCost / packSize. This is the
  // apples-to-apples figure used to rank offers across pack sizes.
  pricePerBaseUnit: number
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

async function getAllRows(userId: string): Promise<PriceRow[]> {
  const rows = await db
    .select({
      priceId: vendorPrices.id,
      productId: vendorPrices.productId,
      vendorId: vendorPrices.vendorId,
      locationId: vendorPrices.locationId,
      unitPrice: vendorPrices.unitPrice,
      shippingCost: vendorPrices.shippingCost,
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
    .where(eq(vendorPrices.userId, userId))

  return rows.map((r) => {
    const unitPrice = Number(r.unitPrice ?? 0)
    const shippingCost = Number(r.shippingCost ?? 0)
    const minOrderQty = Number(r.minOrderQty ?? 1) || 1
    const freightTerms = r.freightTerms ?? 'fob'
    const deliveredPrice =
      r.deliveredPrice !== null && r.deliveredPrice !== undefined
        ? Number(r.deliveredPrice)
        : null

    // FOB landed cost spreads freight across the minimum order quantity.
    const fobLandedUnitCost = unitPrice + shippingCost / minOrderQty
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

    const acquisitionCost =
      effectiveBasis === 'delivered'
        ? landedUnitCost * minOrderQty
        : unitPrice * minOrderQty + shippingCost

    // Normalize to a per-base-unit cost so different pack sizes (e.g. a box of
    // 100 vs a single each) compare fairly. packSize defaults to 1.
    const rawPackSize = Number(r.packSize ?? 1)
    const packSize = rawPackSize > 0 ? rawPackSize : 1
    const pricePerBaseUnit = landedUnitCost / packSize

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
      shippingCost,
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
  const userId = await getUserId()
  const rows = await getAllRows(userId)

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
    const flagged = offers.map((o) => ({
      ...o,
      unitMismatch:
        !!groupUnit && !!norm(o.baseUnit) && norm(o.baseUnit) !== groupUnit,
    }))

    // Rank only comparable offers by normalized per-base-unit cost. Mismatched
    // offers still display, but sort after and never win best/worst.
    const comparable = flagged
      .filter((o) => !o.unitMismatch)
      .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)
    const mismatched = flagged.filter((o) => o.unitMismatch)
    const offersSorted = [...comparable, ...mismatched]
    const best = comparable[0] ?? null
    const worst = comparable[comparable.length - 1] ?? null
    const mixedPackSizes =
      new Set(comparable.map((o) => o.packSize)).size > 1

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
      hasUnitMismatch: mismatched.length > 0,
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
  const userId = await getUserId()
  const rows = await getAllRows(userId)

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

export async function getDashboardStats() {
  const userId = await getUserId()
  const rows = await getAllRows(userId)
  const productIds = new Set(rows.map((r) => r.productId))
  const vendorIds = new Set(rows.map((r) => r.vendorId))

  const comparisons = await getProductComparisons()
  // potentialSavings is per base unit; scale by the base units in a minimum
  // order (packSize * minOrderQty) of the cheapest offer.
  const totalPotentialSavings = comparisons.reduce(
    (sum, c) =>
      sum +
      c.potentialSavings *
        ((c.best?.packSize ?? 1) * (c.best?.minOrderQty ?? 1)),
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
