// Pure (non-server) savings math extracted from app/actions/comparisons.ts so
// it can be imported by both that server-action module and other server
// actions without violating the "every export must be async" rule that the
// 'use server' directive imposes. Types are imported type-only (erased at
// compile time), so this module carries no server-only runtime coupling.

import { packFamily, type PackFamilyId } from '@/lib/pack-family'
import type {
  PriceRow,
  ProductComparison,
  VolumeMaps,
} from '@/app/actions/comparisons'

// A quoted per-base-unit price this far below the group's median is treated as
// a data-entry error (e.g. a $0.03/gal "quote" that is really a rebate or a
// mis-keyed unit) and excluded from best-price selection so it can't fabricate
// an impossible savings floor.
const OUTLIER_LOW_RATIO = 0.15

// Returns the comparable per-base-unit prices in a group with implausible low
// outliers removed, so the cheapest *credible* price can be chosen as the
// switch target.
export function credibleOfferPrices(offers: PriceRow[]): PriceRow[] {
  const priced = offers.filter(
    (o) => o.comparable && o.comparablePricePerBaseUnit > 0,
  )
  if (priced.length < 3) return priced
  const sorted = [...priced].sort(
    (a, b) => a.comparablePricePerBaseUnit - b.comparablePricePerBaseUnit,
  )
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1].comparablePricePerBaseUnit +
          sorted[mid].comparablePricePerBaseUnit) /
        2
      : sorted[mid].comparablePricePerBaseUnit
  const floor = median * OUTLIER_LOW_RATIO
  return priced.filter((o) => o.comparablePricePerBaseUnit >= floor)
}

export type EquivalentLine = {
  productId: number | null
  productName: string
  packFamily: PackFamilyId
  annualVolume: number
  // present-state price/base unit for the product actually bought
  presentUnitCost: number
  // where presentUnitCost came from
  presentBasis: 'current-quote' | 'paid-cost'
  // best credible current price/base unit in the SAME pack family
  bestEquivalentUnitCost: number
  bestEquivalentProductName: string
  savings: number
}

export type EquivalentSavings = {
  canonicalItemId: number
  displayName: string
  totalSavings: number
  // volume that could be priced vs volume with no credible price basis
  pricedVolume: number
  unpricedVolume: number
  confidence: 'high' | 'mixed' | 'low'
  lines: EquivalentLine[]
}

// Computes the present-state "By Equivalent" opportunity for one comparison
// group: for each specific product actually bought, value it at its current
// quote (or its historical paid cost when no current quote exists) and compare
// against the cheapest credible current price of a like-packaged product in the
// same equivalent group, times the volume actually bought. This never pins the
// whole group's volume to a single worst quote.
export function computeEquivalentSavings(
  group: ProductComparison,
  volumes: VolumeMaps,
): EquivalentSavings | null {
  if (!group.isCanonical || group.canonicalItemId === null) return null
  const byProd = volumes.byCanonicalProduct.get(group.canonicalItemId)
  if (!byProd || byProd.size === 0) return null

  // Best credible current price per pack family within this group.
  const credible = credibleOfferPrices(group.offers)
  const bestByFamily = new Map<PackFamilyId, PriceRow>()
  for (const o of credible) {
    const fam = packFamily(o.packSize, o.baseUnit)
    const cur = bestByFamily.get(fam)
    if (!cur || o.comparablePricePerBaseUnit < cur.comparablePricePerBaseUnit) {
      bestByFamily.set(fam, o)
    }
  }
  // Current quote per product (cheapest credible offer for that product).
  const currentByProduct = new Map<number, PriceRow>()
  for (const o of credible) {
    if (o.productId === null) continue
    const cur = currentByProduct.get(o.productId)
    if (!cur || o.comparablePricePerBaseUnit < cur.comparablePricePerBaseUnit) {
      currentByProduct.set(o.productId, o)
    }
  }
  const productName = new Map<number, string>()
  for (const o of group.offers) {
    if (o.productId !== null) productName.set(o.productId, o.productName)
  }

  const lines: EquivalentLine[] = []
  let totalSavings = 0
  let pricedVolume = 0
  let unpricedVolume = 0
  let anyFallback = false

  for (const [productId, perLoc] of byProd) {
    let vol = 0
    let paidNum = 0
    let paidDen = 0
    let baseUnit: string | null = null
    for (const lv of perLoc.values()) {
      vol += lv.annualVolume
      if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
        paidNum += lv.baselineUnitCost * lv.annualVolume
        paidDen += lv.annualVolume
      }
      baseUnit = baseUnit ?? lv.baseUnit
    }
    if (vol <= 0) continue

    // Present-state price for THIS product: prefer its current quote.
    const currentOffer = currentByProduct.get(productId)
    const paidCost = paidDen > 0 ? paidNum / paidDen : null
    let presentUnitCost: number | null = null
    let presentBasis: 'current-quote' | 'paid-cost' = 'current-quote'
    let packFam: PackFamilyId
    if (currentOffer) {
      presentUnitCost = currentOffer.comparablePricePerBaseUnit
      presentBasis = 'current-quote'
      packFam = packFamily(currentOffer.packSize, currentOffer.baseUnit)
    } else if (paidCost !== null) {
      presentUnitCost = paidCost
      presentBasis = 'paid-cost'
      anyFallback = true
      // No current quote for this exact product: infer its pack family from any
      // offer for it, else treat as bulk (the dominant purchased family).
      const anyOffer = group.offers.find((o) => o.productId === productId)
      packFam = anyOffer
        ? packFamily(anyOffer.packSize, anyOffer.baseUnit)
        : 'bulk'
    } else {
      unpricedVolume += vol
      continue
    }

    // Best credible alternative in the SAME pack family. If none exists for
    // that family, this line has no valid like-for-like swap, so no savings.
    const bestAlt = bestByFamily.get(packFam)
    if (!bestAlt) {
      unpricedVolume += vol
      continue
    }
    pricedVolume += vol
    const savings = Math.max(
      0,
      (presentUnitCost - bestAlt.comparablePricePerBaseUnit) * vol,
    )
    totalSavings += savings
    lines.push({
      productId,
      productName: productName.get(productId) ?? `Product ${productId}`,
      packFamily: packFam,
      annualVolume: vol,
      presentUnitCost,
      presentBasis,
      bestEquivalentUnitCost: bestAlt.comparablePricePerBaseUnit,
      bestEquivalentProductName: bestAlt.productName,
      savings,
    })
  }

  if (lines.length === 0) return null
  lines.sort((a, b) => b.savings - a.savings)
  const confidence: EquivalentSavings['confidence'] =
    unpricedVolume > pricedVolume
      ? 'low'
      : anyFallback || unpricedVolume > 0
        ? 'mixed'
        : 'high'

  return {
    canonicalItemId: group.canonicalItemId,
    displayName: group.displayName,
    totalSavings,
    pricedVolume,
    unpricedVolume,
    confidence,
    lines,
  }
}
