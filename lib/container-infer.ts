import type { VendorProfile } from './vendor-profile'

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

// A vendor's container-sizing convention: do they describe containers in metric
// (205 L drum, 1000 L IBC) or imperial (55 gal drum, 275 gal tote)? This is
// distinct from how they quote *price* — e.g. Petro-Canada prices per US gallon
// but sizes its containers in litres — so a bare "DRUM"/"IBC" must be resolved
// using the sizing convention, not the pricing unit.
export type UnitSystem = 'metric' | 'imperial'

// Size tokens like "205L", "20 L", "1040 litre" (metric) vs "55 gal", "275 USG"
// (imperial), as they appear inside product names / container descriptors.
const METRIC_SIZE_RE = /\d+(?:\.\d+)?\s?(?:l|litres?|liters?|ltrs?|ml)\b/gi
const IMPERIAL_SIZE_RE =
  /\d+(?:\.\d+)?\s?(?:usg|gal(?:lon)?s?|qts?|quarts?|pts?|pints?|fl\s?oz)\b/gi

const METRIC_UNIT_WORDS = new Set([...LITRE_ALIASES, ...ML_ALIASES])
const IMPERIAL_UNIT_WORDS = new Set([
  ...GALLON_ALIASES,
  ...QUART_ALIASES,
  ...PINT_ALIASES,
  ...FLOZ_ALIASES,
])

// Decide a vendor's container-sizing convention. Explicit size tokens printed in
// product names ("205L DRUM") are the strongest signal and dominate; the
// vendor's pricing units ("USG") act as a lighter-weight tiebreaker for vendors
// who rarely print container sizes. Defaults to imperial for these North
// American suppliers when there's no signal at all.
export function detectUnitSystem(
  texts: (string | null)[],
  pricingUnits: (string | null)[] = [],
): UnitSystem {
  let metric = 0
  let imperial = 0
  // Strong signal: explicit sized container tokens in names (weight 3).
  for (const raw of texts) {
    const t = raw ?? ''
    if (!t) continue
    metric += (t.match(METRIC_SIZE_RE) ?? []).length * 3
    imperial += (t.match(IMPERIAL_SIZE_RE) ?? []).length * 3
  }
  // Weak signal: how the vendor quotes price (weight 1).
  for (const raw of pricingUnits) {
    const u = raw?.trim().toLowerCase() ?? ''
    if (!u) continue
    if (METRIC_UNIT_WORDS.has(u)) metric += 1
    else if (IMPERIAL_UNIT_WORDS.has(u)) imperial += 1
  }
  return metric > imperial ? 'metric' : 'imperial'
}

// An explicit "<number> <volume unit>" anywhere in the text (e.g. "6 USG",
// "20 L"). Longer unit spellings come first so they win over the bare "l".
const VOL_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(usg|u\.?s\.?\s?gal(?:lon)?s?|gal(?:lon)?s?|litres?|liters?|ltrs?|millilitres?|milliliters?|ml|quarts?|qts?|l)\b/i

const VOL_UNIT_GROUP =
  'usg|gal(?:lon)?s?|litres?|liters?|ltrs?|ml|millilitres?|milliliters?|quarts?|qts?|pints?|pts?|fl\\s?oz|l'

// Weight units, so weight-based packs ("30*0.4kg" = 12 kg) resolve too.
const WEIGHT_UNIT_GROUP =
  'kilograms?|kilos?|kgs?|grammes?|grams?|gms?|gr|pounds?|lbs?|ounces?|ozs?|tonnes?|mt|g'

// All units a pack's inner size may be expressed in (volume + weight).
const PACK_UNIT_GROUP = `${VOL_UNIT_GROUP}|${WEIGHT_UNIT_GROUP}`

// Escape a literal string for safe inclusion in a RegExp.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Build the case-pack regex for a given separator set and extra unit tokens.
// Separators default to "/"; vendors may add others (e.g. "*"). Extra units are
// vendor aliases (e.g. "ugl") appended to the recognized unit alternation.
function buildCasePackRe(separators: string[], extraUnits: string[]): RegExp {
  const sepClass = ['/', ...separators].map(escapeRe).join('')
  const units = [PACK_UNIT_GROUP, ...extraUnits.map(escapeRe)]
    .filter(Boolean)
    .join('|')
  return new RegExp(
    `(\\d+)\\s*[${sepClass}]\\s*(\\d+(?:\\.\\d+)?)\\s*(${units})\\b`,
    'i',
  )
}

function buildSpacedCasePackRe(extraUnits: string[]): RegExp {
  const units = [PACK_UNIT_GROUP, ...extraUnits.map(escapeRe)]
    .filter(Boolean)
    .join('|')
  return new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${units})\\s*(?:case|pack)\\b`, 'i')
}

// Resolve a multi-unit case pack into its true total quantity in native units.
// "12/1 QT" → { qty: 12, unit: "quart" }, "6*1qt" → { qty: 6, unit: "qt" },
// "30*0.4kg" → { qty: 12, unit: "kg" }, "3 Gal Case" → { qty: 3, unit: "gal" } —
// which normalizeContainer then folds into gallons or pounds. When a vendor
// profile is supplied, its separators (e.g. "*") and unit aliases (e.g.
// "ugl"→"gal") are recognized too. Returns null when the text isn't a
// quantifiable pack (e.g. "12/1 Case" with no unit), so the caller leaves it be.
export function resolveCasePack(
  text: string,
  profile?: VendorProfile,
): { qty: number; unit: string } | null {
  const t = text || ''
  const separators = profile ? [...profile.separators] : []
  const aliasKeys = profile ? [...profile.unitAliases.keys()] : []

  const translate = (unit: string): string => {
    if (!profile) return unit
    return profile.unitAliases.get(unit.trim().toLowerCase()) ?? unit
  }

  const m = t.match(buildCasePackRe(separators, aliasKeys))
  if (m) {
    const outer = Number.parseFloat(m[1])
    const inner = Number.parseFloat(m[2])
    if (outer > 0 && inner > 0) {
      return { qty: outer * inner, unit: translate(m[3].trim()) }
    }
  }
  const s = t.match(buildSpacedCasePackRe(aliasKeys))
  if (s) {
    const qty = Number.parseFloat(s[1])
    if (qty > 0) return { qty, unit: translate(s[2].trim()) }
  }
  return null
}

// A tote / IBC labelled with a number ("275 Tote", "330 IBC"). In North America
// these vessels are rated in US gallons (275 and 330 are the standard sizes; a
// 275-gal tote is the same physical container as a 1000 L IBC), and extractors
// frequently misread the bare number as litres. So whenever a number sits next
// to tote/IBC, treat it as gallons — this overrides any AI-guessed unit.
const NUMBERED_TOTE_RE =
  /(\d+(?:\.\d+)?)\s*(?:us\s*)?(?:gal(?:lon)?s?\s*)?(?:tote|ibc)\b/i

// Resolve a numbered tote/IBC to its gallon capacity, or null if not present.
export function resolveNumberedTote(
  text: string,
): { gallons: number } | null {
  const m = (text || '').match(NUMBERED_TOTE_RE)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!(n > 0)) return null
  return { gallons: n }
}

// Container keywords with a standard capacity, given per unit system. A bare
// "DRUM" from a metric vendor is a 205 L drum; from an imperial vendor it's a
// 55 US gallon drum. These are the common North American lubricant sizes.
type ContainerDefault = { re: RegExp; metric: number; imperial: number }
const CONTAINER_DEFAULTS: ContainerDefault[] = [
  // Intermediate bulk container / tote: 1000 L metric, 275 USG imperial.
  { re: /\b(ibc|tote)\b/, metric: 1000, imperial: 275 },
  // Steel/poly drum: 205 L metric, 55 USG imperial.
  { re: /\bdrums?\b/, metric: 205, imperial: 55 },
  // Pail: 20 L metric, 5 USG imperial.
  { re: /\bpails?\b/, metric: 20, imperial: 5 },
]

// Branded boxes with a fixed capacity regardless of the vendor's unit system.
// A Sunoco "E-Pack" / Petro-Canada "PetroPak" is a 6 US gallon box (24 L),
// like a bag-in-box bulk pack.
type FixedContainer = { re: RegExp; gallons: number }
const FIXED_CONTAINERS: FixedContainer[] = [
  { re: /\b(e-?pack|ecopack|petro-?pak|petropak)\b/, gallons: 6 },
]

// Any recognizable container word — used to gate explicit-size acceptance so we
// never grab a stray number (e.g. a viscosity grade) as a capacity.
const CONTAINER_WORD_RE =
  /\b(ibc|tote|drums?|pails?|jugs?|kegs?|cases?|packs?|petro-?pak|e-?pack|ecopack|bottles?|jerry|petropak)\b/

// Infer a container capacity from a product name (+ sku/container text) when
// the extractor found none. `unitSystem` is the source vendor's system, used to
// resolve keyword defaults (a "DRUM" is 205 L for a metric vendor, 55 USG for an
// imperial one). Returns null when nothing can be inferred confidently — those
// rows stay genuinely unspecified.
export function inferContainer(
  text: string,
  unitSystem: UnitSystem = 'imperial',
  profile?: VendorProfile,
): InferredContainer | null {
  const t = (text || '').toLowerCase()
  if (!t.trim()) return null

  // Bulk / decant: sold loose by the gallon. Keep packSize 1 (the per-gallon
  // basis); the Compare view labels these as "1 gal (bulk/decant)".
  if (/\b(bulk|decant|dcnt)\b/.test(t)) return null

  const hasContainerWord = CONTAINER_WORD_RE.test(t)

  // 1) Explicit capacity + volume unit. Accept when a container word is present
  //    or the unit is gallon-class (a strong volume signal on its own). An
  //    explicit printed size always wins over the system default.
  const m = t.match(VOL_UNIT_RE)
  if (m) {
    const size = Number.parseFloat(m[1])
    const unit = m[2].trim()
    const isGallon = /usg|gal/.test(unit)
    if (size > 0 && (hasContainerWord || isGallon)) {
      return { packSize: size, baseUnit: unit, inferred: false }
    }
  }

  // 2) A vendor-specific fixed-size container learned for THIS vendor (e.g. a
  //    branded box) takes precedence over the global defaults below.
  if (profile) {
    for (const [token, gallons] of profile.containers) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(token)}(?![a-z0-9])`, 'i')
      if (re.test(t)) {
        return { packSize: gallons, baseUnit: 'USG', inferred: true }
      }
    }
  }

  // 3) A branded fixed-size box (E-Pack/PetroPak = 6 USG) with no printed size.
  //    These have one capacity regardless of the vendor's unit system.
  for (const f of FIXED_CONTAINERS) {
    if (f.re.test(t)) {
      return { packSize: f.gallons, baseUnit: 'USG', inferred: true }
    }
  }

  // 4) A known container with a standard capacity but no explicit size printed,
  //    resolved in the vendor's own unit system.
  for (const d of CONTAINER_DEFAULTS) {
    if (d.re.test(t)) {
      return unitSystem === 'metric'
        ? { packSize: d.metric, baseUnit: 'litre', inferred: true }
        : { packSize: d.imperial, baseUnit: 'USG', inferred: true }
    }
  }

  return null
}
