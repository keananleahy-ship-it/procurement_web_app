// Some vendors quote a price for the whole package (e.g. $899 for a 55-gallon
// drum, $56 for a 12-quart case) rather than per single unit. The comparison
// engine assumes every stored price is already per base unit (per gallon / per
// pound), so per-package quotes must be converted at import time.
//
// The container capacity is already parsed into `packSize` (normalized to
// gallons for fluids, pounds for greases), so the conversion is simply
// price ÷ packSize. The only real work is deciding whether a given import is
// quoted per-package or per-unit in the first place.

export type PriceBasis = 'per-unit' | 'per-package'

export type BaseKind = 'volume' | 'weight' | 'other'

const VOLUME_UNITS = new Set([
  'usg',
  'gal',
  'gals',
  'gallon',
  'gallons',
  'litre',
  'litres',
  'liter',
  'liters',
  'l',
  'ml',
  'qt',
  'qts',
  'quart',
  'quarts',
  'pt',
  'pint',
  'pints',
])
const WEIGHT_UNITS = new Set([
  'lb',
  'lbs',
  'pound',
  'pounds',
  'kg',
  'kgs',
  'kilogram',
  'kilograms',
  'g',
  'gram',
  'grams',
  'oz',
  'ounce',
  'ounces',
  'tonne',
  'tonnes',
  't',
  'mt',
])

export function baseKind(baseUnit: string | null | undefined): BaseKind {
  const u = (baseUnit ?? '').trim().toLowerCase()
  if (VOLUME_UNITS.has(u)) return 'volume'
  if (WEIGHT_UNITS.has(u)) return 'weight'
  return 'other'
}

// The short word for one base unit, used in human-readable conversion notes.
export function baseUnitWord(baseUnit: string | null | undefined): string {
  return baseKind(baseUnit) === 'weight' ? 'lb' : 'gal'
}

// Plausible maximum price for ONE base unit (a gallon of fluid, a pound of
// grease). A quote above this for a multi-unit container is almost certainly
// the price of the whole package. Deliberately generous so premium synthetics
// are never misread as per-package.
export const PER_UNIT_CEILING: Record<BaseKind, number> = {
  volume: 75,
  weight: 25,
  other: 75,
}

export type PricedRow = {
  // Container capacity normalized to gallons (fluids) or pounds (greases).
  packSize: number
  baseUnit: string | null
  unitPrice: number | null
}

// Decide whether an import quotes prices per single unit (per gallon / per lb)
// or per whole package (per drum / case / pail). Looks only at multi-unit
// containers: if their raw prices are implausibly high to be per-unit yet sane
// once divided by the container size, the file is priced per-package.
export function detectPriceBasis(rows: PricedRow[]): PriceBasis {
  let multiUnit = 0
  let looksPackage = 0
  for (const r of rows) {
    if (r.unitPrice == null || !(r.packSize >= 2)) continue
    multiUnit++
    const ceiling = PER_UNIT_CEILING[baseKind(r.baseUnit)]
    const perUnit = r.unitPrice / r.packSize
    if (r.unitPrice > ceiling && perUnit <= ceiling) looksPackage++
  }
  // Require several real multi-unit containers and a clear majority before
  // declaring per-package, so ordinary per-gallon files are never converted.
  if (multiUnit >= 3 && looksPackage / multiUnit >= 0.6) return 'per-package'
  return 'per-unit'
}

// Decide, for a SINGLE row, whether its price is a whole-package total that
// must be divided by the container size to get a per-base-unit price. This is
// the per-row counterpart to detectPriceBasis, needed because one file can mix
// bases (e.g. bulk lines quoted per gallon alongside case lines quoted as a
// case total). Two independent signals mark a row as per-package:
//
//   1. isCasePack — the container used multi-unit case notation ("24*1qt",
//      "12/1gal"). In these price lists such packs are quoted as a case total,
//      so we divide even when the total happens to fall under the ceiling
//      (e.g. $65.96 for a 6-gal case = ~$11/gal).
//   2. The ceiling heuristic — a multi-unit container whose raw price is
//      implausibly high for one base unit yet sane once divided (e.g. $899 for
//      a 55-gal drum). This catches single large containers (drums/totes) that
//      aren't case packs but are still quoted as a total.
//
// A bulk or single-unit line quoted per gallon (price already under the
// ceiling, no case notation) is left untouched.
export function isPackagePrice(
  row: PricedRow,
  isCasePack: boolean,
): boolean {
  if (row.unitPrice == null) return false
  if (!(row.packSize >= 2)) return false
  if (isCasePack) return true
  const ceiling = PER_UNIT_CEILING[baseKind(row.baseUnit)]
  return row.unitPrice > ceiling && row.unitPrice / row.packSize <= ceiling
}

// Convert a package-total price to a per-base-unit price. Returns the price
// unchanged when there's nothing sensible to divide by.
export function toPerUnit(
  price: number | null,
  packSize: number,
): number | null {
  if (price == null) return null
  if (!(packSize > 0)) return price
  return price / packSize
}
