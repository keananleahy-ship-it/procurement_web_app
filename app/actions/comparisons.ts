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
  // landed cost per unit = unitPrice + shipping spread across the min order
  landedUnitCost: number
  // total acquisition cost to fulfill the minimum order
  acquisitionCost: number
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
  offers: PriceRow[]
  best: PriceRow | null
  worst: PriceRow | null
  vendorCount: number
  potentialSavings: number // worst landed - best landed
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
      minOrderQty: vendorPrices.minOrderQty,
      currency: vendorPrices.currency,
      productName: products.name,
      category: products.category,
      unit: products.unit,
      canonicalItemId: products.canonicalItemId,
      matchStatus: products.matchStatus,
      canonicalItemName: canonicalItems.name,
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
    const landedUnitCost = unitPrice + shippingCost / minOrderQty
    const acquisitionCost = unitPrice * minOrderQty + shippingCost
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
      landedUnitCost,
      acquisitionCost,
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

  const comparisons: ProductComparison[] = []
  for (const [key, offers] of byKey) {
    const sorted = [...offers].sort(
      (a, b) => a.landedUnitCost - b.landedUnitCost,
    )
    const best = sorted[0] ?? null
    const worst = sorted[sorted.length - 1] ?? null
    const vendorIds = new Set(offers.map((o) => o.vendorId))
    const isCanonical = key.startsWith('c')
    const displayName = isCanonical
      ? (offers.find((o) => o.canonicalItemName)?.canonicalItemName ??
        'Canonical item')
      : offers[0].productName
    comparisons.push({
      key,
      displayName,
      productId: offers[0].productId,
      productName: displayName,
      category: offers[0].category,
      unit: offers[0].unit,
      isCanonical,
      offers: sorted,
      best,
      worst,
      vendorCount: vendorIds.size,
      potentialSavings:
        best && worst ? worst.landedUnitCost - best.landedUnitCost : 0,
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
  const totalPotentialSavings = comparisons.reduce(
    (sum, c) => sum + c.potentialSavings * (c.best?.minOrderQty ?? 1),
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
