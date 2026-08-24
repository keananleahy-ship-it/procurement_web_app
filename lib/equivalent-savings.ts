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
  // where this product's volume (and thus its savings) actually sits, so the
  // UI can drill from a lens tile down to the specific sites driving it
  locations: {
    locationId: number | null
    locationName: string
    annualVolume: number
    opportunity: number
    // the like-for-like target this specific site is compared against, and the
    // location that target is sourced from — lets the drill-down show whether
    // the opportunity comes from a within-site or a cross-site swap
    equivalentUnitCost: number
    equivalentProductName: string
    sourceLocationName: string | null
  }[]
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
  // 'cross-site' (default): a site's like-for-like target can be sourced from
  // ANY location. 'within-site': the target must be available at that site's
  // own location (its FOB origin), or be a network-wide offer.
  sourcing: 'cross-site' | 'within-site' = 'cross-site',
): EquivalentSavings | null {
  if (!group.isCanonical || group.canonicalItemId === null) return null
  const byProd = volumes.byCanonicalProduct.get(group.canonicalItemId)
  if (!byProd || byProd.size === 0) return null

  // Best credible current price per pack family within this group (network-wide,
  // ignoring location — used to decide whether a like-for-like swap exists).
  const credible = credibleOfferPrices(group.offers)
  const bestByFamily = new Map<PackFamilyId, PriceRow>()
  for (const o of credible) {
    const fam = packFamily(o.packSize, o.baseUnit)
    const cur = bestByFamily.get(fam)
    if (!cur || o.comparablePricePerBaseUnit < cur.comparablePricePerBaseUnit) {
      bestByFamily.set(fam, o)
    }
  }

  // Cheapest credible like-packaged offer for a given family as seen by a
  // specific buying site. In within-site mode only offers whose FOB origin is
  // that site (or a network-wide offer) qualify; cross-site sees everything.
  const bestFamilyForSite = (
    fam: PackFamilyId,
    locationId: number | null,
  ): PriceRow | undefined => {
    let best: PriceRow | undefined
    for (const o of credible) {
      if (packFamily(o.packSize, o.baseUnit) !== fam) continue
      if (
        sourcing === 'within-site' &&
        o.locationId !== null &&
        o.locationId !== locationId
      )
        continue
      if (
        !best ||
        o.comparablePricePerBaseUnit < best.comparablePricePerBaseUnit
      )
        best = o
    }
    return best
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
  // Prefer the name carried on a current offer, but fall back to the purchased
  // product's own name (from the volume maps) so products bought without any
  // current quote still show a real label instead of "Product <id>".
  const productName = new Map<number, string>()
  for (const o of group.offers) {
    if (o.productId !== null) productName.set(o.productId, o.productName)
  }
  for (const [productId, name] of volumes.productNames) {
    if (!productName.has(productId)) productName.set(productId, name)
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
    const locVols: { locationId: number | null; annualVolume: number }[] = []
    for (const [locationId, lv] of perLoc) {
      vol += lv.annualVolume
      if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
        paidNum += lv.baselineUnitCost * lv.annualVolume
        paidDen += lv.annualVolume
      }
      baseUnit = baseUnit ?? lv.baseUnit
      if (lv.annualVolume > 0) locVols.push({ locationId, annualVolume: lv.annualVolume })
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

    // If no like-for-like swap exists ANYWHERE for this family, the line has no
    // valid equivalent regardless of sourcing mode, so no savings.
    if (!bestByFamily.get(packFam)) {
      unpricedVolume += vol
      continue
    }
    pricedVolume += vol

    // Evaluate each buying site against the cheapest like-packaged equivalent
    // available TO THAT SITE (network-wide in cross-site mode; same-location in
    // within-site mode). A site with no qualifying local option simply shows no
    // opportunity rather than dropping out.
    const srcName = (o: PriceRow): string | null =>
      o.locationId !== null
        ? (volumes.locationNames.get(o.locationId) ?? null)
        : null
    const locationsOut = locVols
      .map((l) => {
        const target = bestFamilyForSite(packFam, l.locationId)
        const targetUnit = target
          ? target.comparablePricePerBaseUnit
          : presentUnitCost
        return {
          locationId: l.locationId,
          locationName: volumes.locationNames.get(l.locationId) ?? 'Unassigned',
          annualVolume: l.annualVolume,
          opportunity: Math.max(0, (presentUnitCost - targetUnit) * l.annualVolume),
          equivalentUnitCost: targetUnit,
          equivalentProductName: target ? target.productName : '—',
          sourceLocationName: target ? srcName(target) : null,
        }
      })
      .sort((a, b) => b.annualVolume - a.annualVolume)

    const savings = locationsOut.reduce((s, l) => s + l.opportunity, 0)
    totalSavings += savings
    // Line-level target: the one driving the largest-volume site that actually
    // has a swap (matches the global best in cross-site mode).
    const rep =
      locationsOut.find((l) => l.equivalentProductName !== '—') ??
      locationsOut[0]
    lines.push({
      productId,
      productName: productName.get(productId) ?? `Product ${productId}`,
      packFamily: packFam,
      annualVolume: vol,
      presentUnitCost,
      presentBasis,
      bestEquivalentUnitCost: rep?.equivalentUnitCost ?? presentUnitCost,
      bestEquivalentProductName: rep?.equivalentProductName ?? '—',
      savings,
      locations: locationsOut,
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
