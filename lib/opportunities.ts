import 'server-only'

import { db } from '@/lib/db'
import { locations, products, purchaseVolumes } from '@/lib/db/schema'
import { getAllRows, rankOffers, traitsOf } from '@/lib/comparison'
import {
  comparisonKey,
  groupLabel,
  missingTraits,
  type TraitKey,
  type Tightness,
} from '@/lib/traits'
import { normalizeUom } from '@/lib/uom'
import { eq } from 'drizzle-orm'

// A buying opportunity: one supplier's price-sheet offer at one location.
export type OpportunityOffer = {
  priceId: number
  productId: number
  productName: string
  brand: string | null
  vendorId: number
  vendorName: string
  locationId: number | null
  locationName: string | null
  region: string | null
  packSize: number
  unit: string | null
  pricePerBaseUnit: number
  freightIncomplete: boolean
}

export type OpportunityGroup = {
  label: string
  baseUnit: string | null
  // comparable offers, cheapest first
  offers: OpportunityOffer[]
}

// What was actually bought: one product at one location.
export type Purchase = {
  id: string
  productId: number
  productName: string
  category: string | null
  locationId: number | null
  locationName: string
  region: string | null
  annualVolume: number
  baseUnit: string | null
  // paid $/base unit; falls back to the product's own offer at the location
  paidUnitCost: number | null
  paidEstimated: boolean
  groupKey: string | null
  // purchase unit differs from the group's offers, so no gap is computed
  unitMismatch: boolean
  missing: TraitKey[]
}

export type OpportunitiesData = {
  groups: Record<string, OpportunityGroup>
  purchases: Purchase[]
  unlinked: { rows: number; annualVolume: number }
}

function toOffer(o: Awaited<ReturnType<typeof getAllRows>>[number] & {
  comparablePricePerBaseUnit: number
}): OpportunityOffer {
  return {
    priceId: o.priceId,
    productId: o.productId,
    productName: o.productName,
    brand: o.brand,
    vendorId: o.vendorId,
    vendorName: o.vendorName,
    locationId: o.locationId,
    locationName: o.locationName,
    region: o.region,
    packSize: o.packSize,
    unit: o.unit,
    pricePerBaseUnit: o.comparablePricePerBaseUnit,
    freightIncomplete: o.freightIncomplete,
  }
}

export async function buildOpportunities(
  tightness: Tightness,
): Promise<OpportunitiesData> {
  const [offerRows, volumeRows] = await Promise.all([
    getAllRows(),
    db
      .select({
        productId: purchaseVolumes.productId,
        locationId: purchaseVolumes.locationId,
        annualVolume: purchaseVolumes.annualVolume,
        baselineUnitCost: purchaseVolumes.baselineUnitCost,
        baseUnit: purchaseVolumes.baseUnit,
        locationName: locations.name,
        region: locations.region,
        productName: products.name,
        category: products.category,
        viscosity: products.viscosity,
        subcategory: products.subcategory,
        performanceSpec: products.performanceSpec,
        brand: products.brand,
        packSize: products.packSize,
        productBaseUnit: products.baseUnit,
        matchStatus: products.matchStatus,
      })
      .from(purchaseVolumes)
      .leftJoin(locations, eq(locations.id, purchaseVolumes.locationId))
      .leftJoin(products, eq(products.id, purchaseVolumes.productId)),
  ])

  // Group every offer by its comparison key; unkeyable offers can't be
  // compared with anything and are left out.
  const byKey = new Map<string, typeof offerRows>()
  const ownOffer = new Map<string, number>()
  for (const r of offerRows) {
    const ownKey = `${r.productId}:${r.locationId}`
    const prev = ownOffer.get(ownKey)
    if (prev === undefined || r.pricePerBaseUnit < prev) {
      ownOffer.set(ownKey, r.pricePerBaseUnit)
    }
    const key = comparisonKey(r.traits, tightness)
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push(r)
    byKey.set(key, list)
  }

  const groups: Record<string, OpportunityGroup> = {}
  const groupUnits = new Map<string, string | null>()
  for (const [key, list] of byKey) {
    const ranked = rankOffers(list, groupLabel(key))
    groupUnits.set(key, ranked.groupUnit)
    groups[key] = {
      label: groupLabel(key),
      baseUnit: ranked.baseUnit,
      offers: ranked.comparable.map((o) =>
        toOffer(o as (typeof list)[number] & typeof o),
      ),
    }
  }

  // Aggregate purchase rows to product x location, volume-weighting paid cost.
  type Acc = Purchase & { costVol: number; costWeight: number }
  const acc = new Map<string, Acc>()
  const unlinked = { rows: 0, annualVolume: 0 }
  for (const r of volumeRows) {
    const vol = Number(r.annualVolume ?? 0)
    if (!Number.isFinite(vol) || vol <= 0) continue
    if (r.productId === null || !r.productName) {
      unlinked.rows++
      unlinked.annualVolume += vol
      continue
    }
    if (r.matchStatus === 'excluded') continue
    const id = `${r.productId}:${r.locationId}`
    let a = acc.get(id)
    if (!a) {
      const traits = traitsOf({ ...r, baseUnit: r.productBaseUnit })
      const groupKey = comparisonKey(traits, tightness)
      a = {
        id,
        productId: r.productId,
        productName: r.productName,
        category: r.category,
        locationId: r.locationId,
        locationName: r.locationName ?? 'Unassigned',
        region: r.region,
        annualVolume: 0,
        baseUnit: r.baseUnit ?? r.productBaseUnit,
        paidUnitCost: null,
        paidEstimated: false,
        groupKey,
        unitMismatch: false,
        missing: groupKey ? [] : missingTraits(traits, tightness),
        costVol: 0,
        costWeight: 0,
      }
      acc.set(id, a)
    }
    a.annualVolume += vol
    const cost = r.baselineUnitCost != null ? Number(r.baselineUnitCost) : NaN
    if (Number.isFinite(cost) && cost > 0) {
      a.costVol += cost * vol
      a.costWeight += vol
    }
  }

  const purchases: Purchase[] = []
  for (const a of acc.values()) {
    const { costVol, costWeight, ...p } = a
    if (costWeight > 0) {
      p.paidUnitCost = costVol / costWeight
    } else {
      const own = ownOffer.get(p.id)
      if (own !== undefined) {
        p.paidUnitCost = own
        p.paidEstimated = true
      }
    }
    if (p.groupKey) {
      const gu = groupUnits.get(p.groupKey)
      const pu = normalizeUom(p.baseUnit)
      p.unitMismatch = Boolean(gu && pu && gu !== pu)
    }
    purchases.push(p)
  }
  purchases.sort((a, b) => b.annualVolume - a.annualVolume)

  return { groups, purchases, unlinked }
}
