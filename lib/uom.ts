// Unit-of-measure helpers shared by extraction and price normalization.
//
// Vendors spell the same physical unit many different ways ("gal", "USG",
// "US Gallon") and also use words that are NOT real measures but containers or
// counts ("each", "case", "drum"). Getting price-per-base-unit right depends on
// telling these apart, so this is the single source of truth for both.

// Canonical measure each synonym maps to. Anything not listed is treated as a
// non-measure (a count or a container) — see isMeasureUom below.
const UOM_SYNONYMS: Record<string, string> = {
  // volume — US gallon
  gal: 'gallon',
  gals: 'gallon',
  gallon: 'gallon',
  gallons: 'gallon',
  usg: 'gallon',
  'us gal': 'gallon',
  'us gallon': 'gallon',
  'us gallons': 'gallon',
  // volume — metric
  l: 'litre',
  lt: 'litre',
  ltr: 'litre',
  litre: 'litre',
  litres: 'litre',
  liter: 'litre',
  liters: 'litre',
  ml: 'millilitre',
  qt: 'quart',
  quart: 'quart',
  // weight
  lb: 'pound',
  lbs: 'pound',
  pound: 'pound',
  pounds: 'pound',
  kg: 'kilogram',
  kgs: 'kilogram',
  kilogram: 'kilogram',
  g: 'gram',
  gram: 'gram',
  grams: 'gram',
  oz: 'ounce',
  ounce: 'ounce',
}

// Words that explicitly mean "a count / a container", never a unit of measure.
// A price quoted per one of these is a per-selling-unit (pack) price.
const NON_MEASURE_UOMS = new Set([
  'each',
  'ea',
  'unit',
  'units',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'case',
  'cases',
  'cs',
  'pack',
  'packs',
  'pkg',
  'package',
  'box',
  'boxes',
  'btl',
  'bottle',
  'bottles',
  'jug',
  'jugs',
  'pail',
  'pails',
  'drum',
  'drums',
  'keg',
  'kegs',
  'tote',
  'totes',
  'ibc',
])

// Normalize a raw unit string to a canonical token for comparison. Unknown
// units fall back to their trimmed/lowercased form so equal spellings still
// match each other.
export function normalizeUom(raw: string | null | undefined): string {
  const u = (raw ?? '').trim().toLowerCase()
  if (u === '') return ''
  return UOM_SYNONYMS[u] ?? u
}

// True when the unit is a real, divisible unit of measure (volume/weight) as
// opposed to a discrete count or a container word.
export function isMeasureUom(raw: string | null | undefined): boolean {
  const u = (raw ?? '').trim().toLowerCase()
  if (u === '') return false
  if (NON_MEASURE_UOMS.has(u)) return false
  // Known synonym => it's a measure. Otherwise treat as a non-measure so we
  // never assume an unfamiliar token (e.g. "each", "ug6") is divisible.
  return u in UOM_SYNONYMS
}

// Decide whether a quoted unit price is already PER BASE UNIT (e.g. $/gallon)
// and therefore must NOT be divided by pack size.
//
// The pricing UNIT is the most direct signal of what a price is "per":
//   stored === 'base'      -> authoritative (AI extraction or reviewer override)
//   pricing unit is a real measure (gal/USG/litre/lb/kg…) -> the price is per
//       that measure, so it is per base unit and must not be divided. A price
//       quoted "$18.28/gal" is never also a per-drum price. This also fixes
//       "gal" vs "USG" spelling and junk base units like "each".
//       Exception: if the base unit is a DIFFERENT real measure (e.g. priced
//       per lb but normalized to gallons), the two aren't directly comparable,
//       so we fall back to per-pack rather than guess.
//   pricing unit is a count/container (each/case/drum…) -> per selling unit,
//       divide by pack size. A 12-pack of filters priced "each" is a case
//       price that must be divided.
export function isPerBaseUnitPrice(args: {
  unit: string | null | undefined
  baseUnit: string | null | undefined
  storedBasis: string | null | undefined
}): boolean {
  if (args.storedBasis === 'base') return true
  if (!isMeasureUom(args.unit)) return false
  const u = normalizeUom(args.unit)
  const b = normalizeUom(args.baseUnit)
  // Base unit empty or a non-measure (e.g. "each") -> trust the pricing unit.
  // Base unit is a real measure -> only per-base if it's the SAME measure.
  if (b === '' || !isMeasureUom(args.baseUnit)) return true
  return u === b
}

// Whether a row's price basis is genuinely ambiguous and worth a human's
// confirmation at import time. It is ambiguous only when ALL hold:
//   - the row packs more than one base unit per selling unit (so dividing vs
//     not dividing actually changes the per-base price), and
//   - the pricing unit does NOT itself settle the question — i.e. it's a
//     container/count word ("drum", "case", "each") or blank, not a real
//     measure like "gal". When the pricing unit is a measure we already know
//     it's per base unit, and when packSize is 1 the division is a no-op.
// A reviewer's explicit choice (storedBasis 'base') is treated as resolved.
export function isBasisAmbiguous(args: {
  unit: string | null | undefined
  packSize: number
  storedBasis?: string | null | undefined
}): boolean {
  if (!Number.isFinite(args.packSize) || args.packSize <= 1) return false
  if (args.storedBasis === 'base') return false
  return !isMeasureUom(args.unit)
}
