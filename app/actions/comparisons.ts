'use server'

import {
  buildComparisons,
  getAllRows,
  loadVolumeMaps as loadVolumeMapsCore,
  type PriceRow,
  type ProductComparison,
  type VolumeMaps,
} from '@/lib/comparison'
import { requireUser } from '@/lib/roles'
import { DEFAULT_TIGHTNESS, type Tightness } from '@/lib/traits'

export type {
  LocationVolume,
  PriceRow,
  ProductComparison,
  VolumeByLocation,
  VolumeMaps,
} from '@/lib/comparison'

export type LocationComparison = {
  locationId: number | null
  locationName: string
  offerCount: number
  avgLandedUnitCost: number
  totalAcquisitionCost: number
  // total annual purchase volume bought at this location (base units/year)
  annualVolume: number
  // annualized savings attributable to this location's volume
  realizableSavings: number
}

export async function getProductComparisons(
  tightness: Tightness = DEFAULT_TIGHTNESS,
): Promise<ProductComparison[]> {
  await requireUser()
  return buildComparisons(tightness)
}

export async function loadVolumeMaps(
  tightness: Tightness = DEFAULT_TIGHTNESS,
): Promise<VolumeMaps> {
  await requireUser()
  return loadVolumeMapsCore(tightness)
}

export async function getLocationComparisons(): Promise<LocationComparison[]> {
  await requireUser()
  const [rows, comparisons] = await Promise.all([
    getAllRows(),
    buildComparisons(),
  ])

  const byLocation = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const key = row.locationId === null ? 'none' : String(row.locationId)
    const list = byLocation.get(key) ?? []
    list.push(row)
    byLocation.set(key, list)
  }

  const volumeByLoc = new Map<
    string,
    { annualVolume: number; realizableSavings: number }
  >()
  for (const c of comparisons) {
    for (const v of c.volumeByLocation) {
      const key = v.locationId === null ? 'none' : String(v.locationId)
      const acc = volumeByLoc.get(key) ?? {
        annualVolume: 0,
        realizableSavings: 0,
      }
      acc.annualVolume += v.annualVolume
      acc.realizableSavings += v.realizableSavings
      volumeByLoc.set(key, acc)
    }
  }

  const result: LocationComparison[] = []
  for (const [locKey, offers] of byLocation) {
    const vol = volumeByLoc.get(locKey) ?? {
      annualVolume: 0,
      realizableSavings: 0,
    }
    result.push({
      locationId: offers[0].locationId,
      locationName: offers[0].locationName ?? 'Unassigned',
      offerCount: offers.length,
      avgLandedUnitCost:
        offers.reduce((sum, o) => sum + o.landedUnitCost, 0) / offers.length,
      totalAcquisitionCost: offers.reduce(
        (sum, o) => sum + o.acquisitionCost,
        0,
      ),
      annualVolume: vol.annualVolume,
      realizableSavings: vol.realizableSavings,
    })
  }
  return result.sort((a, b) => a.avgLandedUnitCost - b.avgLandedUnitCost)
}

export async function getDashboardStats() {
  await requireUser()
  const [rows, comparisons] = await Promise.all([
    getAllRows(),
    buildComparisons(),
  ])
  const hasVolume = comparisons.some((c) => c.annualVolume > 0)
  const totalRealizableSavings = comparisons.reduce(
    (sum, c) => sum + c.realizableSavings,
    0,
  )
  // No-volume fallback: per-unit gap times one minimum order of the best offer.
  const totalMinOrderSavings = comparisons.reduce(
    (sum, c) =>
      sum +
      c.potentialSavings *
        ((c.best?.packSize ?? 1) * (c.best?.minOrderQty ?? 1)),
    0,
  )
  return {
    productCount: new Set(rows.map((r) => r.productId)).size,
    vendorCount: new Set(rows.map((r) => r.vendorId)).size,
    offerCount: rows.length,
    comparableProducts: comparisons.filter((c) => c.vendorCount > 1).length,
    totalPotentialSavings: hasVolume
      ? totalRealizableSavings
      : totalMinOrderSavings,
    savingsAreVolumeWeighted: hasVolume,
    totalAnnualVolume: comparisons.reduce((sum, c) => sum + c.annualVolume, 0),
  }
}
