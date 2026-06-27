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

// Approximate density of petroleum gear oil, expressed as pounds per US gallon
// (gear oils run ~0.90 specific gravity, i.e. ~7.5 lb/gal). This is the bridge
// used to compare a gear oil quoted per pound against one quoted per gallon. It
// is an industry approximation and is applied ONLY to gear oils (see
// isGearOilName) so grease and every other item are never silently converted.
export const GEAR_OIL_LB_PER_GAL = 7.5

// Physical size of each measure in its dimension's reference unit:
// volume in litres, weight in kilograms. Used to derive conversion factors.
const VOLUME_IN_LITRES: Record<string, number> = {
  gallon: 3.785411784,
  quart: 0.946352946,
  litre: 1,
  millilitre: 0.001,
}
const WEIGHT_IN_KG: Record<string, number> = {
  pound: 0.45359237,
  kilogram: 1,
  gram: 0.001,
  ounce: 0.028349523125,
}

type MeasureDimension = 'volume' | 'weight'
function measureDimension(canonical: string): MeasureDimension | null {
  if (canonical in VOLUME_IN_LITRES) return 'volume'
  if (canonical in WEIGHT_IN_KG) return 'weight'
  return null
}

// Factor to multiply a price quoted PER `fromUnit` by so it is expressed PER
// `toUnit`. Equivalently, "how many `fromUnit` fit in one `toUnit`" — a larger
// target unit costs proportionally more (e.g. $/lb -> $/gal multiplies by the
// pounds in a gallon). Returns null when conversion isn't possible:
//   - either side is empty, a count, or a container word, or
//   - a weight<->volume crossing without a density (lbPerGal) supplied.
// Same-unit returns 1; same-dimension uses the physical size ratio; crossing
// weight and volume uses the supplied density.
export function pricePerUnitFactor(
  fromUnit: string | null | undefined,
  toUnit: string | null | undefined,
  opts?: { lbPerGal?: number },
): number | null {
  const from = normalizeUom(fromUnit)
  const to = normalizeUom(toUnit)
  if (from === '' || to === '') return null
  if (from === to) return 1
  if (!isMeasureUom(fromUnit) || !isMeasureUom(toUnit)) return null

  const fromDim = measureDimension(from)
  const toDim = measureDimension(to)
  if (!fromDim || !toDim) return null

  if (fromDim === toDim) {
    const table = fromDim === 'volume' ? VOLUME_IN_LITRES : WEIGHT_IN_KG
    return table[to] / table[from]
  }

  // Cross-dimension (weight <-> volume) needs a density.
  const lbPerGal = opts?.lbPerGal
  if (!lbPerGal || lbPerGal <= 0) return null
  const kgPerLitre =
    (lbPerGal * WEIGHT_IN_KG.pound) / VOLUME_IN_LITRES.gallon
  if (fromDim === 'weight' && toDim === 'volume') {
    // weight units per volume unit = (volume size in L * density) / weight size in kg
    return (VOLUME_IN_LITRES[to] * kgPerLitre) / WEIGHT_IN_KG[from]
  }
  // volume units per weight unit (the reciprocal arrangement)
  return WEIGHT_IN_KG[to] / (VOLUME_IN_LITRES[from] * kgPerLitre)
}

// Whether a product/canonical name denotes a GEAR OIL, which vendors quote in a
// mix of per-pound and per-gallon and therefore must be normalized to a single
// unit. Grease is deliberately excluded: it is consistently priced per pound
// across vendors and must stay that way, so any name mentioning "grease" is
// never treated as a gear oil even if it also says "gear".
export function isGearOilName(
  ...names: (string | null | undefined)[]
): boolean {
  const text = names
    .filter((n): n is string => !!n)
    .join(' ')
    .toLowerCase()
  if (text.includes('grease')) return false
  return text.includes('gear')
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
