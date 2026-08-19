'use server'

import {
  getProductComparisons,
  loadVolumeMaps,
  type LocationVolume,
} from '@/app/actions/comparisons'
import { requireUser } from '@/lib/roles'
import { normalizeUom } from '@/lib/uom'
import { packFamily, PACK_FAMILIES, type PackFamilyId } from '@/lib/pack-family'

// The three savings lenses all operate on ONE canonical (equivalent) item at a
// time and are each a different slice of the same price variance. They are NOT
// additive — a gallon of savings found "by location" may be the same gallon a
// packaging switch would capture — so the UI shows the three side by side and
// never sums them into a single number.

// Lens 1: the same equivalent item is paid for at different prices across
// sites. Target = best available vendor quote for the item (per the approved
// design), so each site's gap is what it could save by buying at the network's
// best quoted price.
export type LocationOpportunity = {
  locationId: number | null
  locationName: string
  annualVolume: number
  paidUnitCost: number
  bestQuote: number
  bestQuoteLabel: string
  savingsPerUnit: number
  opportunity: number
}

// Lens 2: within the canonical, spend sits on pricier equivalent products when
// a cheaper comparable exists. Opportunity = per-unit spread (worst-best) times
// the item's annual volume.
export type EquivalentOpportunity = {
  annualVolume: number
  bestLabel: string
  bestPerUnit: number
  worstLabel: string
  worstPerUnit: number
  spreadPerUnit: number
  opportunity: number
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
    const groupUnit = normalizeUom(c.baseUnit)
    const best = c.best
    const perLoc = volumes.byCanonical.get(canonicalItemId)

    // A paid baseline is only trustworthy when its unit matches the group's
    // comparison unit (or no unit was recorded) — otherwise we'd compare apples
    // to oranges, so we skip it exactly as the comparison engine does.
    const baselineIsUnitSafe = (lv: LocationVolume) =>
      lv.baselineUnitCost !== null &&
      (!lv.baseUnit || !groupUnit || normalizeUom(lv.baseUnit) === groupUnit)

    // ---- Lens 1: by location ------------------------------------------------
    const byLocation: LocationOpportunity[] = []
    if (best && perLoc) {
      const bestQuote = best.comparablePricePerBaseUnit
      const bestQuoteLabel = offerLabel(best.vendorName, best.productName)
      for (const [locationId, lv] of perLoc) {
        if (!baselineIsUnitSafe(lv)) continue
        const paidUnitCost = lv.baselineUnitCost as number
        const savingsPerUnit = Math.max(0, paidUnitCost - bestQuote)
        byLocation.push({
          locationId,
          locationName: volumes.locationNames.get(locationId) ?? 'Unassigned',
          annualVolume: lv.annualVolume,
          paidUnitCost,
          bestQuote,
          bestQuoteLabel,
          savingsPerUnit,
          opportunity: savingsPerUnit * lv.annualVolume,
        })
      }
      byLocation.sort((a, b) => b.opportunity - a.opportunity)
    }
    const byLocationTotal = byLocation.reduce((s, r) => s + r.opportunity, 0)

    // Blended paid cost + total paid spend across unit-safe sites.
    let spendNum = 0
    let spendVol = 0
    if (perLoc) {
      for (const lv of perLoc.values()) {
        if (!baselineIsUnitSafe(lv)) continue
        spendNum += (lv.baselineUnitCost as number) * lv.annualVolume
        spendVol += lv.annualVolume
      }
    }
    const blendedPaidUnitCost = spendVol > 0 ? spendNum / spendVol : null
    const totalPaidSpend = spendVol > 0 ? spendNum : null

    // ---- Lens 2: by equivalent product -------------------------------------
    let byEquivalent: EquivalentOpportunity | null = null
    if (best && c.worst && c.potentialSavings > 0) {
      byEquivalent = {
        annualVolume: c.annualVolume,
        bestLabel: offerLabel(best.vendorName, best.productName),
        bestPerUnit: best.comparablePricePerBaseUnit,
        worstLabel: offerLabel(c.worst.vendorName, c.worst.productName),
        worstPerUnit: c.worst.comparablePricePerBaseUnit,
        spreadPerUnit: c.potentialSavings,
        opportunity: c.potentialSavings * c.annualVolume,
      }
    }

    // ---- Lens 3: by packaging ----------------------------------------------
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
