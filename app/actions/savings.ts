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

// Lens 3: the SAME (like-for-like) product is bought in a pricier container than
// an available cheaper container format — e.g. drums that could be bulk. For
// each container a customer actually buys in, we recommend the cheapest cheaper
// container available for the item and value the switchable volume at the
// per-unit container premium. Opportunity = sum of those per-container premiums.
export type PackOption = {
  family: PackFamilyId
  familyLabel: string
  cheapestPerUnit: number
  cheapestLabel: string
  offerCount: number
  deltaFromCheapest: number
}
// A single site buying a given product (used inside product rows so the tile
// can drill family -> product -> location).
export type PackagingSiteRow = {
  locationId: number | null
  locationName: string
  annualVolume: number
}
// One container the customer actually buys the item in, with the cheaper
// container we recommend switching that volume to (when one exists) and the
// products/sites behind it, so every finding is "you buy X in drums, buy it in
// bulk instead" rather than an anonymous volume total.
export type PackagingBreakdownRow = {
  family: PackFamilyId
  familyLabel: string
  annualVolume: number
  blendedPaidUnitCost: number | null
  // best comparable rate available IN THIS container — the baseline the switch
  // is measured against, so the delta is a pure container premium (brand-level
  // overpay within the container belongs to the other lenses). Falls back to
  // blended paid when the container has no comparable offer on file.
  currentBestPerUnit: number | null
  // true when this container is already the item's cheapest format (no switch)
  isCheapestFamily: boolean
  // recommended cheaper container for this volume; null when none is cheaper
  targetFamily: PackFamilyId | null
  targetFamilyLabel: string | null
  targetPerUnit: number | null
  targetLabel: string | null
  targetOfferCount: number
  // per-unit container premium and its annual value for this container's volume
  savingsPerUnit: number
  opportunity: number
  // the distinct products purchased in this container, each with its own site
  // split, so the finding names the SKUs involved rather than a bare number.
  // In same-product basis each product carries its OWN container switch (same
  // branded line, cheaper pack), since the switch is product-specific there.
  products: {
    productId: number
    productName: string
    annualVolume: number
    blendedPaidUnitCost: number | null
    // present rate and recommended cheaper container FOR THIS product line;
    // null target when no cheaper same-line container is reachable
    currentBestPerUnit: number | null
    targetFamilyLabel: string | null
    targetPerUnit: number | null
    targetLabel: string | null
    opportunity: number
    locations: PackagingSiteRow[]
  }[]
  locations: PackagingSiteRow[]
}
export type PackagingOpportunity = {
  annualVolume: number
  blendedPaidUnitCost: number | null
  cheapestFamily: PackFamilyId
  cheapestFamilyLabel: string
  cheapestPerUnit: number
  options: PackOption[]
  opportunity: number | null
  // per-container switch findings (with per-product and per-site split)
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
  // active By Packaging comparison basis: 'equivalent' allows a container
  // switch to any like-for-like product; 'same-product' restricts it to the
  // same branded product line (a pure packaging move, no brand change)
  packagingBasis: 'equivalent' | 'same-product'
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
    packagingBasis?: 'equivalent' | 'same-product'
  },
): Promise<SavingsResult> {
  await requireUser()

  const equivalentSourcing = opts?.equivalentSourcing ?? 'cross-site'
  const packagingBasis = opts?.packagingBasis ?? 'equivalent'

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
    // Same container rates, but broken out by the offer's FOB-origin location
    // (null = a network-wide offer). Used only for the target-container lookup
    // when sourcing is restricted to a buying site (within-site mode).
    type FamLocOffer = {
      cheapestPerUnit: number
      cheapestLabel: string
      offerCount: number
    }
    const familyByLoc = new Map<
      PackFamilyId,
      Map<number | null, FamLocOffer>
    >()
    for (const o of comparableOffers) {
      const fam = packFamily(o.packSize, o.baseUnit)
      const byLoc = familyByLoc.get(fam) ?? new Map<number | null, FamLocOffer>()
      const cur = byLoc.get(o.locationId)
      const label = offerLabel(o.vendorName, o.productName)
      if (!cur) {
        byLoc.set(o.locationId, {
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
      familyByLoc.set(fam, byLoc)
    }
    // Cheapest offer in a container as SEEN BY a specific buying site: the whole
    // network in cross-site mode, or only that site's FOB origin plus any
    // network-wide offer in within-site mode.
    const familyOfferForSite = (
      fam: PackFamilyId,
      locationId: number | null,
    ): FamLocOffer | undefined => {
      if (equivalentSourcing === 'cross-site') return familyMap.get(fam)
      const byLoc = familyByLoc.get(fam)
      if (!byLoc) return undefined
      const atSite = locationId !== null ? byLoc.get(locationId) : undefined
      const network = byLoc.get(null)
      if (atSite && network)
        return atSite.cheapestPerUnit <= network.cheapestPerUnit
          ? atSite
          : network
      return atSite ?? network
    }

    // ---- Same-product basis ------------------------------------------------
    // The same container rates, but keyed by product-LINE (brand + product
    // family + spec, independent of packaging) so a container switch can be
    // restricted to the SAME branded product — a pure packaging move with no
    // brand change. Uses productLineKey, the same identity By Location uses.
    const lineFamilyByLoc = new Map<
      string,
      Map<PackFamilyId, Map<number | null, FamLocOffer>>
    >()
    for (const o of comparableOffers) {
      const plk = productLineKey(o.productName)
      if (!plk) continue
      const fam = packFamily(o.packSize, o.baseUnit)
      const famMap =
        lineFamilyByLoc.get(plk) ??
        new Map<PackFamilyId, Map<number | null, FamLocOffer>>()
      const byLoc = famMap.get(fam) ?? new Map<number | null, FamLocOffer>()
      const cur = byLoc.get(o.locationId)
      const label = offerLabel(o.vendorName, o.productName)
      if (!cur) {
        byLoc.set(o.locationId, {
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
      famMap.set(fam, byLoc)
      lineFamilyByLoc.set(plk, famMap)
    }
    // Cheapest same-line offer in a container as seen by a site, honoring the
    // sourcing toggle exactly like familyOfferForSite.
    const lineOfferForSite = (
      plk: string,
      fam: PackFamilyId,
      locationId: number | null,
    ): FamLocOffer | undefined => {
      const byLoc = lineFamilyByLoc.get(plk)?.get(fam)
      if (!byLoc) return undefined
      const network = byLoc.get(null)
      if (equivalentSourcing === 'cross-site') {
        // cheapest across every location this line is quoted in
        let best: FamLocOffer | undefined
        for (const v of byLoc.values()) {
          if (!best || v.cheapestPerUnit < best.cheapestPerUnit) best = v
        }
        return best
      }
      const atSite = locationId !== null ? byLoc.get(locationId) : undefined
      if (atSite && network)
        return atSite.cheapestPerUnit <= network.cheapestPerUnit
          ? atSite
          : network
      return atSite ?? network
    }
    // Mode-aware current-container rate for a product line at a site.
    const currentRateForSite = (
      plk: string,
      fam: PackFamilyId,
      locationId: number | null,
    ): FamLocOffer | undefined =>
      packagingBasis === 'same-product'
        ? lineOfferForSite(plk, fam, locationId)
        : familyOfferForSite(fam, locationId)
    // Mode-aware cheapest cheaper-container target for a product line at a site.
    const targetContainerForSite = (
      plk: string,
      fromFam: PackFamilyId,
      locationId: number | null,
      currentPerUnit: number,
    ): { family: PackFamilyId; perUnit: number; label: string; offerCount: number } | null => {
      const candidateFamilies: Iterable<PackFamilyId> =
        packagingBasis === 'same-product'
          ? (lineFamilyByLoc.get(plk)?.keys() ?? new Set<PackFamilyId>())
          : familyByLoc.keys()
      let best:
        | { family: PackFamilyId; perUnit: number; label: string; offerCount: number }
        | null = null
      for (const f2 of candidateFamilies) {
        if (f2 === fromFam) continue
        const cand = currentRateForSite(plk, f2, locationId)
        if (!cand || cand.cheapestPerUnit >= currentPerUnit) continue
        if (!best || cand.cheapestPerUnit < best.perUnit) {
          best = {
            family: f2,
            perUnit: cand.cheapestPerUnit,
            label: cand.cheapestLabel,
            offerCount: cand.offerCount,
          }
        }
      }
      return best
    }
    // Network-wide present rate in a container (stable across sites, like the
    // By Equivalent baseline): any-product cheapest in equivalent basis, or the
    // same product line's cheapest in same-product basis.
    const presentRate = (plk: string, fam: PackFamilyId): number | null => {
      if (packagingBasis === 'same-product') {
        const byLoc = lineFamilyByLoc.get(plk)?.get(fam)
        if (!byLoc) return null
        let best: number | null = null
        for (const v of byLoc.values())
          if (best === null || v.cheapestPerUnit < best)
            best = v.cheapestPerUnit
        return best
      }
      return familyMap.get(fam)?.cheapestPerUnit ?? null
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
    type ProdAgg = {
      annualVolume: number
      paidNum: number
      paidDen: number
      locations: Map<number | null, number>
    }
    type FamAgg = {
      annualVolume: number
      paidNum: number
      paidDen: number
      locations: Map<number | null, number>
      products: Map<number, ProdAgg>
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
          products: new Map<number, ProdAgg>(),
        }
        const prod = agg.products.get(productId) ?? {
          annualVolume: 0,
          paidNum: 0,
          paidDen: 0,
          locations: new Map<number | null, number>(),
        }
        for (const [locationId, lv] of locMap) {
          agg.annualVolume += lv.annualVolume
          prod.annualVolume += lv.annualVolume
          if (lv.baselineUnitCost !== null && lv.baselineUnitCost > 0) {
            const spend = lv.baselineUnitCost * lv.annualVolume
            agg.paidNum += spend
            agg.paidDen += lv.annualVolume
            prod.paidNum += spend
            prod.paidDen += lv.annualVolume
          }
          agg.locations.set(
            locationId,
            (agg.locations.get(locationId) ?? 0) + lv.annualVolume,
          )
          prod.locations.set(
            locationId,
            (prod.locations.get(locationId) ?? 0) + lv.annualVolume,
          )
        }
        agg.products.set(productId, prod)
        famAgg.set(fam, agg)
      }
    }
    const siteRows = (locs: Map<number | null, number>): PackagingSiteRow[] =>
      [...locs.entries()]
        .map(([locationId, annualVolume]) => ({
          locationId,
          locationName: volumes.locationNames.get(locationId) ?? 'Unassigned',
          annualVolume,
        }))
        .sort((a, b) => b.annualVolume - a.annualVolume)
    const breakdown: PackagingBreakdownRow[] = [...famAgg.entries()]
      .map(([family, agg]) => {
        const famOffer = familyMap.get(family)
        const famPaid = agg.paidDen > 0 ? agg.paidNum / agg.paidDen : null
        type TargetPick = {
          family: PackFamilyId
          perUnit: number
          label: string
          offerCount: number
        }
        // Opportunity is computed per PRODUCT so the same-product basis can hold
        // each product line to its own container switch. The present rate is
        // network-wide (a stable baseline, like the By Equivalent lens); the
        // cheaper-container target is site-aware so within-site correctly drops
        // sites that can't source the cheaper pack locally.
        let opportunity = 0
        // family header representative = largest-volume product with a switch.
        // Collected into an array (not closure-mutated lets) so the roll-up is
        // computed cleanly after the per-product map.
        const reps: { volume: number; target: TargetPick; present: number }[] =
          []
        const products = [...agg.products.entries()]
          .map(([productId, p]) => {
            const productName =
              volumes.productNames.get(productId) ?? `Product ${productId}`
            const plk = productLineKey(productName)
            const prodPaid = p.paidDen > 0 ? p.paidNum / p.paidDen : null
            const present =
              presentRate(plk, family) ??
              (packagingBasis === 'same-product' ? prodPaid : famPaid)
            let prodOpp = 0
            let prodTarget: TargetPick | null = null
            let prodRepVol = -1
            if (present !== null) {
              for (const [locationId, vol] of p.locations) {
                const t = targetContainerForSite(
                  plk,
                  family,
                  locationId,
                  present,
                )
                if (!t) continue
                prodOpp += Math.max(0, present - t.perUnit) * vol
                if (vol > prodRepVol) {
                  prodRepVol = vol
                  prodTarget = t
                }
              }
            }
            opportunity += prodOpp
            if (prodTarget && present !== null) {
              reps.push({
                volume: p.annualVolume,
                target: prodTarget,
                present,
              })
            }
            return {
              productId,
              productName,
              annualVolume: p.annualVolume,
              blendedPaidUnitCost: prodPaid,
              currentBestPerUnit: present,
              targetFamilyLabel: prodTarget
                ? familyLabel(prodTarget.family)
                : null,
              targetPerUnit: prodTarget ? prodTarget.perUnit : null,
              targetLabel: prodTarget ? prodTarget.label : null,
              opportunity: prodOpp,
              locations: siteRows(p.locations),
            }
          })
          .sort(
            (a, b) =>
              b.opportunity - a.opportunity || b.annualVolume - a.annualVolume,
          )

        // Roll-up representative: the largest-volume product line that has a
        // switch, driving the row header's target and present rate.
        const rep =
          reps.length > 0
            ? reps.reduce((a, b) => (b.volume > a.volume ? b : a))
            : null
        // Header present rate: any-product family rate in equivalent basis; the
        // representative product line's rate in same-product basis.
        const currentBestPerUnit =
          packagingBasis === 'same-product'
            ? (rep?.present ?? (famOffer ? famOffer.cheapestPerUnit : famPaid))
            : famOffer
              ? famOffer.cheapestPerUnit
              : famPaid
        const savingsPerUnit =
          currentBestPerUnit !== null && rep
            ? Math.max(0, currentBestPerUnit - rep.target.perUnit)
            : 0
        return {
          family,
          familyLabel: familyLabel(family),
          annualVolume: agg.annualVolume,
          blendedPaidUnitCost: famPaid,
          currentBestPerUnit,
          isCheapestFamily: family === cheapestFamilyId,
          targetFamily: rep ? rep.target.family : null,
          targetFamilyLabel: rep ? familyLabel(rep.target.family) : null,
          targetPerUnit: rep ? rep.target.perUnit : null,
          targetLabel: rep ? rep.target.label : null,
          targetOfferCount: rep ? rep.target.offerCount : 0,
          savingsPerUnit,
          opportunity,
          products,
          locations: siteRows(agg.locations),
        }
      })
      // biggest container-switch opportunity first; ties fall back to volume
      .sort((a, b) => b.opportunity - a.opportunity || b.annualVolume - a.annualVolume)

    const byPackaging: PackagingOpportunity = {
      annualVolume: c.annualVolume,
      blendedPaidUnitCost,
      cheapestFamily: cheapestFamilyId,
      cheapestFamilyLabel: cheapest ? familyLabel(cheapest[0]) : '—',
      cheapestPerUnit,
      options,
      // total container premium across every container the item is bought in
      opportunity: breakdown.reduce((s, r) => s + r.opportunity, 0),
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
    packagingBasis,
  }
}
