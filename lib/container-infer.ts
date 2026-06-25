// Container-size normalization and inference for imported price rows.
//
// Two responsibilities:
//   1. normalizeContainer() — fold a parsed container capacity into a canonical
//      unit (litres -> US gallons, kilograms -> pounds) so vendors quoting in
//      different units compare apples-to-apples.
//   2. inferContainer() — a deterministic fallback for industry container
//      shorthands the AI extractor misses (e.g. "6 USG PETROPAK", a bare "IBC"
//      or "DRUM"). It runs only when no pack size was parsed, and returns the
//      capacity in NATIVE units so normalizeContainer() can fold it like any
//      other size.

// Most vendors quote in US gallons, so we normalize litre-based container
// capacities to gallons for apples-to-apples comparison.
const LITRES_PER_USG = 3.785411784
const LITRE_ALIASES = new Set([
  'l',
  'litre',
  'litres',
  'liter',
  'liters',
  'ltr',
  'ltrs',
])
const GALLON_ALIASES = new Set([
  'usg',
  'gal',
  'gals',
  'gallon',
  'gallons',
  'us gal',
  'us gallon',
])
const QUARTS_PER_USG = 4
const QUART_ALIASES = new Set(['qt', 'qts', 'quart', 'quarts'])
const ML_PER_USG = 3785.411784
const ML_ALIASES = new Set([
  'ml',
  'mls',
  'millilitre',
  'millilitres',
  'milliliter',
  'milliliters',
  'cc',
])
const FLOZ_PER_USG = 128
const FLOZ_ALIASES = new Set([
  'fl oz',
  'floz',
  'fl. oz.',
  'fl oz.',
  'fluid ounce',
  'fluid ounces',
])
const PINTS_PER_USG = 8
const PINT_ALIASES = new Set(['pt', 'pts', 'pint', 'pints'])

// Weight-based capacities are normalized to pounds so kilogram-quoted vendors
// compare directly against pound-quoted ones.
const KG_PER_LB = 0.45359237
const GRAMS_PER_LB = 453.59237
const KG_PER_TONNE = 1000
const KILOGRAM_ALIASES = new Set([
  'kg',
  'kgs',
  'kilo',
  'kilos',
  'kilogram',
  'kilograms',
])
const GRAM_ALIASES = new Set([
  'g',
  'gr',
  'gm',
  'gms',
  'gram',
  'grams',
  'gramme',
  'grammes',
])
const TONNE_ALIASES = new Set([
  't',
  'mt',
  'tonne',
  'tonnes',
  'metric ton',
  'metric tons',
  'metric tonne',
  'metric tonnes',
])
const POUND_ALIASES = new Set(['lb', 'lbs', 'pound', 'pounds'])
const OUNCES_PER_LB = 16
const OUNCE_ALIASES = new Set(['oz', 'ozs', 'ounce', 'ounces'])

// Given a raw container capacity + base unit, return the capacity expressed in
// a canonical unit: litres -> US gallons, kilograms -> pounds. Other units
// (each, case, ...) pass through unchanged.
export function normalizeContainer(
  packSize: number,
  baseUnit: string | null,
): { packSize: string; baseUnit: string | null } {
  const u = baseUnit?.trim().toLowerCase() ?? ''
  if (LITRE_ALIASES.has(u)) {
    return { packSize: (packSize / LITRES_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (GALLON_ALIASES.has(u)) {
    return { packSize: packSize.toFixed(4), baseUnit: 'USG' }
  }
  if (QUART_ALIASES.has(u)) {
    return { packSize: (packSize / QUARTS_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (PINT_ALIASES.has(u)) {
    return { packSize: (packSize / PINTS_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (FLOZ_ALIASES.has(u)) {
    return { packSize: (packSize / FLOZ_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (ML_ALIASES.has(u)) {
    return { packSize: (packSize / ML_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (KILOGRAM_ALIASES.has(u)) {
    return { packSize: (packSize / KG_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  if (GRAM_ALIASES.has(u)) {
    return { packSize: (packSize / GRAMS_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  if (TONNE_ALIASES.has(u)) {
    return {
      packSize: ((packSize * KG_PER_TONNE) / KG_PER_LB).toFixed(4),
      baseUnit: 'lb',
    }
  }
  if (POUND_ALIASES.has(u)) {
    return { packSize: packSize.toFixed(4), baseUnit: 'lb' }
  }
  if (OUNCE_ALIASES.has(u)) {
    return { packSize: (packSize / OUNCES_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  return { packSize: packSize.toFixed(4), baseUnit: baseUnit?.trim() || null }
}

export type InferredContainer = {
  // Capacity in native units (e.g. litres, USG) — pass through normalizeContainer.
  packSize: number
  baseUnit: string
  // True when we fell back to a standard container size rather than reading an
  // explicit one from the text, so the row can be flagged for human review.
  inferred: boolean
}

// An explicit "<number> <volume unit>" anywhere in the text (e.g. "6 USG",
// "20 L"). Longer unit spellings come first so they win over the bare "l".
const VOL_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(usg|u\.?s\.?\s?gal(?:lon)?s?|gal(?:lon)?s?|litres?|liters?|ltrs?|millilitres?|milliliters?|ml|quarts?|qts?|l)\b/i

// Container keywords with a standard capacity for these lubricant/fluid vendors
// when no explicit size is printed. Capacities are in litres.
const CONTAINER_DEFAULTS: { re: RegExp; packSize: number; baseUnit: string }[] =
  [
    // Intermediate bulk container / tote: standard 1000 L.
    { re: /\b(ibc|tote)\b/, packSize: 1000, baseUnit: 'litre' },
    // Steel/poly drum: standard 205 L for oils on these sheets.
    { re: /\bdrums?\b/, packSize: 205, baseUnit: 'litre' },
    // Pail: standard 20 L.
    { re: /\bpails?\b/, packSize: 20, baseUnit: 'litre' },
  ]

// Any recognizable container word — used to gate explicit-size acceptance so we
// never grab a stray number (e.g. a viscosity grade) as a capacity.
const CONTAINER_WORD_RE =
  /\b(ibc|tote|drums?|pails?|jugs?|kegs?|cases?|packs?|petro-?pak|e-?pack|ecopack|bottles?|jerry|petropak)\b/

// Infer a container capacity from a product name (+ sku/container text) when
// the extractor found none. Returns null when nothing can be inferred
// confidently — those rows stay genuinely unspecified.
export function inferContainer(text: string): InferredContainer | null {
  const t = (text || '').toLowerCase()
  if (!t.trim()) return null

  // Bulk / decant: sold loose by the gallon. Keep packSize 1 (the per-gallon
  // basis); the Compare view labels these as "1 gal (bulk/decant)".
  if (/\b(bulk|decant|dcnt)\b/.test(t)) return null

  const hasContainerWord = CONTAINER_WORD_RE.test(t)

  // 1) Explicit capacity + volume unit. Accept when a container word is present
  //    or the unit is gallon-class (a strong volume signal on its own).
  const m = t.match(VOL_UNIT_RE)
  if (m) {
    const size = Number.parseFloat(m[1])
    const unit = m[2].trim()
    const isGallon = /usg|gal/.test(unit)
    if (size > 0 && (hasContainerWord || isGallon)) {
      return { packSize: size, baseUnit: unit, inferred: false }
    }
  }

  // 2) A known container with a standard capacity but no explicit size printed.
  for (const d of CONTAINER_DEFAULTS) {
    if (d.re.test(t)) {
      return { packSize: d.packSize, baseUnit: d.baseUnit, inferred: true }
    }
  }

  return null
}
