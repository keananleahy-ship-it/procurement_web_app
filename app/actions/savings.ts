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
// One purchased pack family with the sites that buy it, so the packaging tile
// can drill down to where the volume (and therefore the opportunity) resides.
export type PackagingBreakdownRow = {
  family: PackFamilyId
  familyLabel: string
  annualVolume: number
  blendedPaidUnitCost: number | null
  isCheapestFamily: boolean
  locations: {
    locationId: number | null
    locationName: string
    annualVolume: number
  }[]
}
export type PackagingOpportunity = {
  annualVolume: number
  blendedPaidUnitCost: number | null
  cheapestFamily: PackFamilyId
  cheapestFamilyLabel: string
  cheapestPerUnit: number
  options: PackOption[]
  opportunity: number | null
  // purchased volume grouped by pack family (with per-site split)
  breakdown: PackagingBreakdownRow[]
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

export type VendorRef = { id: number; name: string }

export type SavingsResult = {
  items: SavingsItem[]
  totals: {
    byLocation: number
    byEquivalent: number
    byPackaging: number
    annualVolume: number
  }
  // every vendor quoting into these groups (unaffected by the current filter),
  // plus which ones are currently excluded, so the UI can render the toggles
  vendors: VendorRef[]
  excludedVendorIds: number[]
  // active By Equivalent sourcing mode, echoed back so the UI toggle can
  // reflect the state the numbers were computed under
  equivalentSourcing: 'cross-site' | 'within-site'
}

const familyLabel = (id: PackFamilyId) =>
  PACK_FAMILIES.find((f) => f.id === id)?.label ?? id

const offerLabel = (vendorName: string, productName: string) =>
  `${vendorName} — ${productName}`

// Packaging / size words stripped when deriving a product-LINE identity, so
// pack variants of one branded product collapse together.
const PACK_WORDS = new Set([
  'bulk', 'drum', 'drums', 'pail', 'pails', 'tote', 'totes', 'ibc', 'ibcs',
  'case', 'cases', 'decant', 'keg', 'kegs', 'box', 'boxes', 'pack', 'jug',
  'jugs', 'can', 'cans', 'cs', 'ea', 'each',
])
// Reduce a product name to a stable product-LINE key: same brand + product
// family + spec, independent of packaging and pack size. This lets By Location
// treat, e.g., "P66 MEGAFLOW AW HYDRAULIC OIL 46" and its "... 46 BULK" drum
// variant as one sourceable line, while keeping distinct lines (MEGAFLOW vs
// POWERFLOW) apart. Tokens containing digits (viscosity, sizes) and single
// characters (e.g. the 't' left by "T/275") are dropped. Callers scope this
// within a single canonical item, so viscosity never needs to be in the key.
const productLineKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !PACK_WORDS.has(t) && !/\d/.test(t))
    .join(' ')
    .trim()

// Build the three savings lenses for AW hydraulic. Read-only: reuses the
// comparison engine (offers, best/worst, per-location volume) and the paid
// baselines from purchase volumes; no pricing math is redefined here.
export async function getAwSavingsAnalyses(
  opts?: {
    excludedVendorIds?: number[]
    equivalentSourcing?: 'cross-site' | 'within-site'
  },
): Promise<SavingsResult> {
  await requireUser()

  const equivalentSourcing = opts?.equivalentSourcing ?? 'cross-site'

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

  // Vendor roster across all AW groups, independent of the active filter, so
  // the toggle list stays stable even while some vendors are switched off.
  const vendorMap = new Map<number, string>()
  for (const c of awGroups) {
    for (const o of c.offers) {
      if (!vendorMap.has(o.vendorId)) vendorMap.set(o.vendorId, o.vendorName)
    }
  }
  const vendors: VendorRef[] = [...vendorMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const excludedVendorIds = (opts?.excludedVendorIds ?? []).filter((id) =>
    vendorMap.has(id),
  )
  const excludedSet = new Set(excludedVendorIds)

  const items: SavingsItem[] = []

  for (const rawGroup of awGroups) {
    // Apply the vendor filter to the QUOTES only; purchased volume is never
    // filtered, so toggling a vendor off changes the pricing targets each lens
    // can reach without changing how much was actually bought.
    const c =
      excludedSet.size > 0
        ? {
            ...rawGroup,
            offers: rawGroup.offers.filter((o) => !excludedSet.has(o.vendorId)),
          }
        : rawGroup
    const canonicalItemId = c.canonicalItemId as number
    const byProd = volumes.byCanonicalProduct.get(canonicalItemId)
    const perLoc = volumes.byCanonical.get(canonicalItemId)

    // ---- Lens 1: BY LOCATION (current price a site pays vs best in the line) -
    // Group offers and purchased volume by PRODUCT LINE (same brand + spec,
    // packaging-agnostic), because the same product often exists under several
    // product ids (e.g. a bulk row and a drum row). For each line: price every
    // site at the current landed cost of the variant IT buys, and compare to
    // the single cheapest landed offer anywhere in that line, times the site's
    // historical volume. This surfaces a site paying a premium (often just a
    // dearer package) for something the network sources cheaper. A site can
    // show savings on its own — no cross-site pairing is required.

    // The line a product belongs to, resolved from its name; falls back to the
    // product id when a name yields no usable tokens so it stays its own line.
    const lineOf = (productId: number, name: string | undefined): string => {
      const k = productLineKey(name ?? '')
      return k.length > 0 ? k : `pid:${productId}`
    }

    // Offers grouped by line, plus the set of offers touching each product id
    // (so a site can be priced by the exact variant it purchases).
    const offersByLine = new Map<string, PriceRow[]>()
    const offersByProductId = new Map<number, PriceRow[]>()
    for (const o of c.offers) {
      if (
        o.productId === null ||
        !o.comparable ||
        !(o.comparablePricePerBaseUnit > 0)
      )
        continue
      const key = lineOf(o.productId, o.productName)
      const la = offersByLine.get(key) ?? []
      la.push(o)
      offersByLine.set(key, la)
      const pa = offersByProductId.get(o.productId) ?? []
      pa.push(o)
      offersByProductId.set(o.productId, pa)
    }

    // Aggregate purchased volume by line -> site, tracking which product ids a
    // site bought (to price it) and a volume-weighted paid baseline (fallback
    // when the site's own variant has no current offer).
    type LineSite = {
      annualVolume: number
      productIds: Set<number>
      paidNum: number
      paidDen: number
    }
    type LineAgg = {
      displayName: string
      displayVolume: number
      sites: Map<number | null, LineSite>
    }
    const lineAggs = new Map<string, LineAgg>()
    if (byProd) {
      for (const [productId, locMap] of byProd) {
        const name = volumes.productNames.get(productId)
        const key = lineOf(productId, name)
        const agg =
          lineAggs.get(key) ??
          ({
            displayName: name ?? `Product ${productId}`,
            displayVolume: -1,
            sites: new Map<number | null, LineSite>(),
          } satisfies LineAgg)
        for (const [locationId, lv] of locMap) {
          if (lv.annualVolume <= 0) continue
          const site =
            agg.sites.get(locationId) ??
            ({
              annualVolume: 0,
              productIds: new Set<number>(),
              paidNum: 0,
              paidDen: 0,
            } satisfies LineSite)
          site.annualVolume += lv.annualVolume
          site.productIds.add(productId)
          if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
            site.paidNum += lv.baselineUnitCost * lv.annualVolume
            site.paidDen += lv.annualVolume
          }
          agg.sites.set(locationId, site)
        }
        // Label the line after its highest-volume product so the row reads as
        // the thing the buyer actually purchases.
        const lineVol = [...locMap.values()].reduce(
          (s, lv) => s + Math.max(0, lv.annualVolume),
          0,
        )
        if (lineVol > agg.displayVolume) {
          agg.displayName = name ?? `Product ${productId}`
          agg.displayVolume = lineVol
        }
        lineAggs.set(key, agg)
      }
    }

    const byLocationLines: LocationProductLine[] = []
    for (const [key, agg] of lineAggs) {
      const lineOffers = offersByLine.get(key)
      if (!lineOffers || lineOffers.length === 0) continue
      // Cheapest landed offer anywhere in the line = the sourcing target.
      const bestOffer = lineOffers.reduce((m, o) =>
        o.comparablePricePerBaseUnit < m.comparablePricePerBaseUnit ? o : m,
      )
      const bestUnitCost = bestOffer.comparablePricePerBaseUnit
      const fam = packFamily(bestOffer.packSize, bestOffer.baseUnit)
      const bestSourceName =
        bestOffer.locationId !== null
          ? (volumes.locationNames.get(bestOffer.locationId) ??
            bestOffer.vendorName)
          : bestOffer.vendorName

      const sites = [...agg.sites.entries()]
        .map(([locationId, site]) => {
          // Price the site by the variant(s) it actually buys; else any offer
          // routed to that site; else the line's network-wide offers; else the
          // baseline it historically paid.
          const buyable = lineOffers.filter(
            (o) =>
              (o.productId !== null && site.productIds.has(o.productId)) ||
              o.locationId === locationId ||
              o.locationId === null,
          )
          let unitCost: number | null = null
          if (buyable.length > 0) {
            unitCost = buyable.reduce(
              (m, o) => Math.min(m, o.comparablePricePerBaseUnit),
              Number.POSITIVE_INFINITY,
            )
          } else if (site.paidDen > 0) {
            unitCost = site.paidNum / site.paidDen
          }
          return { locationId, site, unitCost }
        })
        .filter(
          (r) =>
            r.unitCost !== null &&
            Number.isFinite(r.unitCost) &&
            (r.unitCost as number) > bestUnitCost,
        )
        .map((r) => {
          const savingsPerUnit = (r.unitCost as number) - bestUnitCost
          return {
            locationId: r.locationId,
            locationName:
              volumes.locationNames.get(r.locationId) ?? 'Unassigned',
            annualVolume: r.site.annualVolume,
            unitCost: r.unitCost as number,
            savingsPerUnit,
            opportunity: savingsPerUnit * r.site.annualVolume,
          }
        })
        .sort((a, b) => b.opportunity - a.opportunity)
      if (sites.length === 0) continue

      const repProductId = [...agg.sites.values()][0]?.productIds
        .values()
        .next().value
      byLocationLines.push({
        productId: repProductId ?? bestOffer.productId ?? 0,
        productName: agg.displayName,
        packFamilyLabel: familyLabel(fam),
        bestSiteName: bestSourceName,
        bestUnitCost,
        sites,
        opportunity: sites.reduce((s, x) => s + x.opportunity, 0),
      })
    }
    byLocationLines.sort((a, b) => b.opportunity - a.opportunity)
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
          bestQuoteLabel: `${line.bestSiteName} (best on offer)`,
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
    const equiv = computeEquivalentSavings(c, volumes, equivalentSourcing)
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
    const cheapestFamilyId: PackFamilyId = cheapest ? cheapest[0] : 'other'

    // Drill-down: the volume actually purchased, grouped by pack family and the
    // sites buying it. A product's family is inferred from any offer for it
    // (using the unfiltered roster so a toggled-off vendor can't hide purchased
    // volume), falling back to bulk when the product has no pack info on file.
    const productFamily = new Map<number, PackFamilyId>()
    for (const o of rawGroup.offers) {
      if (o.productId !== null && !productFamily.has(o.productId)) {
        productFamily.set(o.productId, packFamily(o.packSize, o.baseUnit))
      }
    }
    type FamAgg = {
      annualVolume: number
      paidNum: number
      paidDen: number
      locations: Map<number | null, number>
    }
    const famAgg = new Map<PackFamilyId, FamAgg>()
    if (byProd) {
      for (const [productId, locMap] of byProd) {
        const fam = productFamily.get(productId) ?? 'bulk'
        const agg = famAgg.get(fam) ?? {
          annualVolume: 0,
          paidNum: 0,
          paidDen: 0,
          locations: new Map<number | null, number>(),
        }
        for (const [locationId, lv] of locMap) {
          agg.annualVolume += lv.annualVolume
          if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
            agg.paidNum += lv.baselineUnitCost * lv.annualVolume
            agg.paidDen += lv.annualVolume
          }
          agg.locations.set(
            locationId,
            (agg.locations.get(locationId) ?? 0) + lv.annualVolume,
          )
        }
        famAgg.set(fam, agg)
      }
    }
    const breakdown: PackagingBreakdownRow[] = [...famAgg.entries()]
      .map(([family, agg]) => ({
        family,
        familyLabel: familyLabel(family),
        annualVolume: agg.annualVolume,
        blendedPaidUnitCost: agg.paidDen > 0 ? agg.paidNum / agg.paidDen : null,
        isCheapestFamily: family === cheapestFamilyId,
        locations: [...agg.locations.entries()]
          .map(([locationId, annualVolume]) => ({
            locationId,
            locationName: volumes.locationNames.get(locationId) ?? 'Unassigned',
            annualVolume,
          }))
          .sort((a, b) => b.annualVolume - a.annualVolume),
      }))
      .sort((a, b) => b.annualVolume - a.annualVolume)

    const byPackaging: PackagingOpportunity = {
      annualVolume: c.annualVolume,
      blendedPaidUnitCost,
      cheapestFamily: cheapestFamilyId,
      cheapestFamilyLabel: cheapest ? familyLabel(cheapest[0]) : '—',
      cheapestPerUnit,
      options,
      opportunity:
        blendedPaidUnitCost !== null && cheapest
          ? Math.max(0, blendedPaidUnitCost - cheapestPerUnit) * c.annualVolume
          : null,
      breakdown,
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
    vendors,
    excludedVendorIds,
    equivalentSourcing,
  }
}
