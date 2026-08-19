'use server'

import { getProductComparisons, loadVolumeMaps } from '@/app/actions/comparisons'
import type { PriceRow } from '@/app/actions/comparisons'
import {
  computeEquivalentSavings,
  type EquivalentSavings,
} from '@/lib/equivalent-savings'
import { requireUser } from '@/lib/roles'
import { packFamily, PACK_FAMILIES, type PackFamilyId } from '@/lib/pack-family'

// The three savings lenses all operate on ONE canonical (equivalent) item at a
// time and are each a different slice of the same price variance. They are NOT
// additive — a gallon of savings found "by location" may be the same gallon a
// packaging switch would capture — so the UI shows the three side by side and
// never sums them into a single number.

// Lens 1: BY LOCATION — the SAME exact product/package is bought at more than
// one site at different prices. Target = the lowest price any site currently
// pays for that same product; each other site's gap x its volume is what buying
// at the network's best in-network price for that identical item would save.
// This is a pure procurement-consolidation signal: no product or package
// substitution is implied.
export type LocationProductLine = {
  productId: number
  productName: string
  packFamilyLabel: string
  // the site paying the lowest price for this exact product
  bestSiteName: string
  bestUnitCost: number
  // per-site detail for the sites paying more than the best site
  sites: {
    locationId: number | null
    locationName: string
    annualVolume: number
    unitCost: number
    savingsPerUnit: number
    opportunity: number
  }[]
  opportunity: number
}
export type LocationOpportunity = {
  // aggregate kept for existing callers: total cross-site opportunity here
  locationId: number | null
  locationName: string
  annualVolume: number
  paidUnitCost: number
  bestQuote: number
  bestQuoteLabel: string
  savingsPerUnit: number
  opportunity: number
}

// Lens 2: BY EQUIVALENT — present-state. For each specific product actually
// bought, value it at its current quote (or historical paid cost when it has no
// current quote) and compare against the cheapest credible current price of a
// like-packaged equivalent, x the volume actually bought. Never pins the whole
// group's volume to a single worst quote. Computed by computeEquivalentSavings.
export type EquivalentOpportunity = {
  annualVolume: number
  bestLabel: string
  bestPerUnit: number
  worstLabel: string
  worstPerUnit: number
  spreadPerUnit: number
  opportunity: number
  // present-state metadata
  confidence: EquivalentSavings['confidence']
  pricedVolume: number
  unpricedVolume: number
  lines: EquivalentSavings['lines']
}

// Lens 3: the item is offered in several pack formats at very different $/unit.
// Opportunity = gap between blended paid cost and the cheapest pack family,
// times annual volume (null when there is no trustworthy paid baseline).
export type PackOption = {
  family: PackFamilyId
  familyLabel: string
  cheapestPerUnit: number
  cheapestLabel: string
  offerCount: number
  deltaFromCheapest: number
}
export type PackagingOpportunity = {
  annualVolume: number
  blendedPaidUnitCost: number | null
  cheapestFamily: PackFamilyId
  cheapestFamilyLabel: string
  cheapestPerUnit: number
  options: PackOption[]
  opportunity: number | null
}

export type SavingsItem = {
  canonicalItemId: number
  name: string
  viscosity: string | null
  baseUnit: string | null
  annualVolume: number
  // total paid spend/year across sites with a trustworthy baseline (null when
  // none), so a card can show the dollars in play, not just the opportunity.
  totalPaidSpend: number | null
  byLocation: LocationOpportunity[]
  // per-product cross-site detail backing byLocation (same exact product bought
  // cheaper at another site). Empty when nothing is bought at >1 site.
  byLocationLines: LocationProductLine[]
  byLocationTotal: number
  byEquivalent: EquivalentOpportunity | null
  byPackaging: PackagingOpportunity
}

export type SavingsResult = {
  items: SavingsItem[]
  totals: {
    byLocation: number
    byEquivalent: number
    byPackaging: number
    annualVolume: number
  }
}

const familyLabel = (id: PackFamilyId) =>
  PACK_FAMILIES.find((f) => f.id === id)?.label ?? id

const offerLabel = (vendorName: string, productName: string) =>
  `${vendorName} — ${productName}`

// Build the three savings lenses for AW hydraulic. Read-only: reuses the
// comparison engine (offers, best/worst, per-location volume) and the paid
// baselines from purchase volumes; no pricing math is redefined here.
export async function getAwSavingsAnalyses(): Promise<SavingsResult> {
  await requireUser()

  const [comparisons, volumes] = await Promise.all([
    getProductComparisons(),
    loadVolumeMaps(),
  ])

  const awGroups = comparisons.filter(
    (c) =>
      c.isCanonical &&
      c.canonicalItemId !== null &&
      c.category === 'Hydraulic Fluid' &&
      c.subcategory === 'AW',
  )

  const items: SavingsItem[] = []

  for (const c of awGroups) {
    const canonicalItemId = c.canonicalItemId as number
    const byProd = volumes.byCanonicalProduct.get(canonicalItemId)
    const perLoc = volumes.byCanonical.get(canonicalItemId)

    // ---- Lens 1: BY LOCATION (same exact product, cheaper at another site) --
    // Both sides are valued at CURRENT pricing (not the historical average paid
    // price). For each specific product bought at more than one site, each
    // site's current unit cost is its live quote — a location-specific quote
    // when one exists, otherwise the product's network-wide current quote — and
    // the target is the cheapest current price among the participating sites.
    // This compares like-for-like (same product/package). Where a product has a
    // single current price network-wide, every site is equal and no location
    // opportunity is credited.
    const currentOffersByProduct = new Map<number, PriceRow[]>()
    for (const o of c.offers) {
      if (!o.comparable) continue
      const arr = currentOffersByProduct.get(o.productId) ?? []
      arr.push(o)
      currentOffersByProduct.set(o.productId, arr)
    }
    // Current unit cost (per base unit) for a product at a given site: prefer a
    // location-specific live quote, else the product's network-wide (unassigned
    // location) quote, else the cheapest live quote anywhere for that product.
    const currentCostAt = (
      productId: number,
      locationId: number | null,
    ): number | null => {
      const offers = currentOffersByProduct.get(productId)
      if (!offers || offers.length === 0) return null
      const locSpecific = offers.filter((o) => o.locationId === locationId)
      const network = offers.filter((o) => o.locationId === null)
      const pick =
        locSpecific.length > 0
          ? locSpecific
          : network.length > 0
            ? network
            : offers
      const best = pick.reduce(
        (m, o) => Math.min(m, o.comparablePricePerBaseUnit),
        Number.POSITIVE_INFINITY,
      )
      return Number.isFinite(best) && best > 0 ? best : null
    }

    const byLocationLines: LocationProductLine[] = []
    if (byProd) {
      for (const [productId, locMap] of byProd) {
        const priced = [...locMap.entries()]
          .map(([locationId, lv]) => ({
            locationId,
            lv,
            cost: currentCostAt(productId, locationId),
          }))
          .filter((r) => r.cost !== null && r.lv.annualVolume > 0)
        if (priced.length < 2) continue // needs 2+ sites to be a location play
        const bestSite = priced.reduce((m, r) =>
          (r.cost as number) < (m.cost as number) ? r : m,
        )
        const bestUnitCost = bestSite.cost as number
        const anyOffer = c.offers.find((o) => o.productId === productId)
        const fam = anyOffer
          ? packFamily(anyOffer.packSize, anyOffer.baseUnit)
          : 'bulk'
        const sites = priced
          .filter((r) => (r.cost as number) > bestUnitCost)
          .map((r) => {
            const savingsPerUnit = (r.cost as number) - bestUnitCost
            return {
              locationId: r.locationId,
              locationName:
                volumes.locationNames.get(r.locationId) ?? 'Unassigned',
              annualVolume: r.lv.annualVolume,
              unitCost: r.cost as number,
              savingsPerUnit,
              opportunity: savingsPerUnit * r.lv.annualVolume,
            }
          })
          .sort((a, b) => b.opportunity - a.opportunity)
        if (sites.length === 0) continue
        byLocationLines.push({
          productId,
          productName: anyOffer?.productName ?? `Product ${productId}`,
          packFamilyLabel: familyLabel(fam),
          bestSiteName:
            volumes.locationNames.get(bestSite.locationId) ?? 'Unassigned',
          bestUnitCost,
          sites,
          opportunity: sites.reduce((s, x) => s + x.opportunity, 0),
        })
      }
      byLocationLines.sort((a, b) => b.opportunity - a.opportunity)
    }
    const byLocationTotal = byLocationLines.reduce(
      (s, r) => s + r.opportunity,
      0,
    )
    // Legacy per-location aggregate (kept for existing callers): roll the
    // per-product cross-site opportunity up to each dearer site.
    const locAgg = new Map<number | null, LocationOpportunity>()
    for (const line of byLocationLines) {
      for (const s of line.sites) {
        const cur = locAgg.get(s.locationId) ?? {
          locationId: s.locationId,
          locationName: s.locationName,
          annualVolume: 0,
          paidUnitCost: 0,
          bestQuote: line.bestUnitCost,
          bestQuoteLabel: `${line.bestSiteName} (current best)`,
          savingsPerUnit: 0,
          opportunity: 0,
        }
        cur.annualVolume += s.annualVolume
        cur.opportunity += s.opportunity
        locAgg.set(s.locationId, cur)
      }
    }
    const byLocation = [...locAgg.values()].sort(
      (a, b) => b.opportunity - a.opportunity,
    )

    // Total paid spend across sites with a trustworthy baseline (from the
    // per-product breakdown), so a card can show the dollars in play.
    let spendNum = 0
    let spendVol = 0
    if (byProd) {
      for (const locMap of byProd.values()) {
        for (const lv of locMap.values()) {
          if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
            spendNum += lv.baselineUnitCost * lv.annualVolume
            spendVol += lv.annualVolume
          }
        }
      }
    }
    const totalPaidSpend = spendVol > 0 ? spendNum : null

    // ---- Lens 2: BY EQUIVALENT (present-state) ------------------------------
    const equiv = computeEquivalentSavings(c, volumes)
    let byEquivalent: EquivalentOpportunity | null = null
    if (equiv && equiv.totalSavings > 0) {
      const top = equiv.lines[0]
      byEquivalent = {
        annualVolume: equiv.pricedVolume,
        // "best" = cheapest like-for-like target on the biggest line
        bestLabel: top?.bestEquivalentProductName ?? '—',
        bestPerUnit: top?.bestEquivalentUnitCost ?? 0,
        // "worst" = the present price of the priciest bought product
        worstLabel: top?.productName ?? '—',
        worstPerUnit: top?.presentUnitCost ?? 0,
        spreadPerUnit:
          top && top.annualVolume > 0 ? top.savings / top.annualVolume : 0,
        opportunity: equiv.totalSavings,
        confidence: equiv.confidence,
        pricedVolume: equiv.pricedVolume,
        unpricedVolume: equiv.unpricedVolume,
        lines: equiv.lines,
      }
    }

    // ---- Lens 3: by packaging ----------------------------------------------
    // Blended paid $/unit across all sites with a trustworthy baseline, used as
    // the packaging-switch baseline (unchanged behavior; not the reported bug).
    const blendedPaidUnitCost = spendVol > 0 ? spendNum / spendVol : null
    const comparableOffers = c.offers.filter((o) => o.comparable)
    const familyMap = new Map<
      PackFamilyId,
      { cheapestPerUnit: number; cheapestLabel: string; offerCount: number }
    >()
    for (const o of comparableOffers) {
      const fam = packFamily(o.packSize, o.baseUnit)
      const cur = familyMap.get(fam)
      const label = offerLabel(o.vendorName, o.productName)
      if (!cur) {
        familyMap.set(fam, {
          cheapestPerUnit: o.comparablePricePerBaseUnit,
          cheapestLabel: label,
          offerCount: 1,
        })
      } else {
        cur.offerCount++
        if (o.comparablePricePerBaseUnit < cur.cheapestPerUnit) {
          cur.cheapestPerUnit = o.comparablePricePerBaseUnit
          cur.cheapestLabel = label
        }
      }
    }
    const familyEntries = [...familyMap.entries()].sort(
      (a, b) => a[1].cheapestPerUnit - b[1].cheapestPerUnit,
    )
    const cheapest = familyEntries[0]
    const options: PackOption[] = familyEntries.map(([family, v]) => ({
      family,
      familyLabel: familyLabel(family),
      cheapestPerUnit: v.cheapestPerUnit,
      cheapestLabel: v.cheapestLabel,
      offerCount: v.offerCount,
      deltaFromCheapest: cheapest
        ? v.cheapestPerUnit - cheapest[1].cheapestPerUnit
        : 0,
    }))
    const cheapestPerUnit = cheapest ? cheapest[1].cheapestPerUnit : 0
    const byPackaging: PackagingOpportunity = {
      annualVolume: c.annualVolume,
      blendedPaidUnitCost,
      cheapestFamily: cheapest ? cheapest[0] : 'other',
      cheapestFamilyLabel: cheapest ? familyLabel(cheapest[0]) : '—',
      cheapestPerUnit,
      options,
      opportunity:
        blendedPaidUnitCost !== null && cheapest
          ? Math.max(0, blendedPaidUnitCost - cheapestPerUnit) * c.annualVolume
          : null,
    }

    items.push({
      canonicalItemId,
      name: c.displayName,
      viscosity: c.viscosity,
      baseUnit: c.baseUnit,
      annualVolume: c.annualVolume,
      totalPaidSpend,
      byLocation,
      byLocationLines,
      byLocationTotal,
      byEquivalent,
      byPackaging,
    })
  }

  // Order items by the largest single-lens opportunity, so the biggest wins
  // surface first regardless of which lens drives them.
  items.sort((a, b) => {
    const aMax = Math.max(
      a.byLocationTotal,
      a.byEquivalent?.opportunity ?? 0,
      a.byPackaging.opportunity ?? 0,
    )
    const bMax = Math.max(
      b.byLocationTotal,
      b.byEquivalent?.opportunity ?? 0,
      b.byPackaging.opportunity ?? 0,
    )
    return bMax - aMax
  })

  return {
    items,
    totals: {
      byLocation: items.reduce((s, i) => s + i.byLocationTotal, 0),
      byEquivalent: items.reduce(
        (s, i) => s + (i.byEquivalent?.opportunity ?? 0),
        0,
      ),
      byPackaging: items.reduce(
        (s, i) => s + (i.byPackaging.opportunity ?? 0),
        0,
      ),
      annualVolume: items.reduce((s, i) => s + i.annualVolume, 0),
    },
  }
}
