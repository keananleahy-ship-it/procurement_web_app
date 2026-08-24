// Pack-size "families" group physically similar containers so the Compare page
// can filter to like-for-like packaging. Families are measurement-aware: the
// liquid (gallon) families never absorb weight/count packs, since those aren't
// comparable containers.
//
// Rules (per product request):
//   - Bulk:  pack size exactly 1 (sold as a single unit) — overrides Cases.
//   - Liquid (volume base unit):
//       Cases  4 gal and under
//       Pails  ~5–6 gal
//       Kegs   ~15 gal
//       Drums  ~55 gal
//       Totes  ~275 gal (IBC)
//   - Other: weight/count packs not yet assigned to a family.

export type PackFamilyId =
  | 'bulk'
  | 'cases'
  | 'pails'
  | 'kegs'
  | 'drums'
  | 'totes'
  | 'other'

export const PACK_FAMILIES: {
  id: PackFamilyId
  label: string
  description: string
}[] = [
  {
    id: 'bulk',
    label: 'Bulk / Single',
    description: 'Sold as a single unit (pack size 1)',
  },
  { id: 'cases', label: 'Cases', description: 'Liquid · 4 gal and under' },
  { id: 'pails', label: 'Pails', description: 'Liquid · ~5–6 gal' },
  { id: 'kegs', label: 'Kegs', description: 'Liquid · ~15 gal' },
  { id: 'drums', label: 'Drums', description: 'Liquid · ~55 gal' },
  { id: 'totes', label: 'Totes', description: 'Liquid · ~275 gal (IBC)' },
  {
    id: 'other',
    label: 'Other',
    description: 'Weight or count packs not yet grouped',
  },
]

const VOLUME_UNITS = new Set([
  'gal',
  'gals',
  'gallon',
  'gallons',
  'usg',
  'us gal',
  'us gallon',
  'us gallons',
])

function isVolumeUnit(unit: string | null | undefined): boolean {
  if (!unit) return false
  return VOLUME_UNITS.has(unit.trim().toLowerCase())
}

// Classify a single offer into a pack family. Boundaries are set slightly wide
// so unit-conversion duplicates (e.g. 4.2268 USG = 16 L, 54.95 USG = 55 gal)
// land with their nominal container size.
export function packFamily(
  packSize: number,
  baseUnit: string | null | undefined,
): PackFamilyId {
  if (packSize === 1) return 'bulk'
  if (isVolumeUnit(baseUnit)) {
    if (packSize <= 4.5) return 'cases'
    if (packSize <= 7) return 'pails'
    if (packSize <= 30) return 'kegs'
    if (packSize <= 120) return 'drums'
    return 'totes'
  }
  return 'other'
}

// Words that describe the CONTAINER/packaging rather than the product itself.
// CONSERVATIVE ON PURPOSE: this list holds only unambiguous container words. It
// deliberately excludes bare measures like "gal"/"lb"/"oz" on their own, because
// a lone number+measure is only packaging in context (see stripPackaging).
const PACK_WORDS = new Set([
  'bulk',
  'case',
  'cases',
  'cs',
  'drum',
  'drums',
  'drm',
  'pail',
  'pails',
  'keg',
  'kegs',
  'tote',
  'totes',
  'ibc',
  'each',
  'ea',
  'box',
  'bx',
  'bag',
  'bags',
  'bottle',
  'bottles',
  'btl',
  'jug',
  'jugs',
  'tt', // "T/T" = tank truck delivery, a logistics note
])

// Container measure units. A NUMBER immediately followed by one of these is a
// pack size ("55 GAL", "20 L", "205 L", "14 OZ"); the number alone is not.
const MEASURE_UNITS = new Set([
  'oz',
  'qt',
  'qts',
  'quart',
  'quarts',
  'gal',
  'gals',
  'gallon',
  'gallons',
  'l',
  'ltr',
  'liter',
  'liters',
  'lb',
  'lbs',
  'kg',
  'ml',
])

// Is this token a PACK-COUNT ratio like "3/1", "12/1", "1/55", "1/5", "1/120"?
// The tell is that one side is exactly "1" (one container, or N of one unit).
// Viscosity grades such as "15/40", "85/140", "0/16" have no "1" side, so they
// are NOT treated as packaging and keep their product identity.
function isPackRatio(tok: string): boolean {
  const m = tok.match(/^(\d+)\/(\d+)$/)
  if (!m) return false
  return m[1] === '1' || m[2] === '1'
}

// Is a single token clearly packaging on its own (a container word, a glued
// size like "10/14oz"/"55gal", or a 1-based pack ratio)? Bare numbers and
// viscosity grades are intentionally NOT packaging here — they carry product
// identity — so they are kept.
function isStandalonePackToken(tok: string): boolean {
  const t = tok.toLowerCase()
  if (PACK_WORDS.has(t)) return true
  if (t === 't/t') return true // tank-truck delivery note
  if (isPackRatio(t)) return true
  // number (optionally a ratio) glued to a measure unit: 55gal, 20l, 10/14oz
  if (/^[\d/.]+(oz|qt|qts|gal|gals|gallon|gallons|l|ltr|lb|lbs|kg|ml)$/.test(t))
    return true
  return false
}

// Remove packaging tokens from a token list WITHOUT touching product identity.
// Handles the two-token case "<number> <measure>" (e.g. "55 GAL", "20 L") by
// dropping both, while leaving lone numbers (product/ISO grades like 600, 68,
// 220) and viscosity grades (15/40, 85W140) intact.
function stripPackaging(tokens: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase()
    // "<number> <measure>" → packaging, skip both tokens.
    if (
      /^\d+(\.\d+)?$/.test(t) &&
      i + 1 < tokens.length &&
      MEASURE_UNITS.has(tokens[i + 1].toLowerCase())
    ) {
      i++ // also skip the measure unit
      continue
    }
    if (isStandalonePackToken(t)) continue
    kept.push(tokens[i])
  }
  return kept
}

// Split a vendor label into an optional leading PACK PREFIX and the remainder.
// Many labels are "<pack prefix>-<product>" ("3/1 CASE-CITGARD 600 SAE 15/40").
// We only treat the pre-hyphen segment as a prefix when every one of its tokens
// is packaging, so a hyphenated product name is never truncated.
function splitPackPrefix(name: string): string {
  const dash = name.indexOf('-')
  if (dash > 0 && dash < name.length - 1) {
    const prefixTokens = name
      .slice(0, dash)
      .split(/[^A-Za-z0-9/.]+/)
      .filter(Boolean)
    const looksLikePack =
      prefixTokens.length > 0 &&
      prefixTokens.every(
        (t) => isStandalonePackToken(t) || /^\d+(\.\d+)?$/.test(t),
      )
    if (looksLikePack) return name.slice(dash + 1)
  }
  return name
}

// Derive the UNDERLYING PRODUCT KEY from a vendor item label by removing only
// the packaging description, so every pack form of ONE product collapses to the
// same key while DIFFERENT products stay apart. Vendor-agnostic: it keys off the
// label's own pack words / sizes, not any vendor's code layout. Suggestion-only
// callers use this to CLUSTER products; a human confirms every grouping, so the
// key is a strong hint, never authoritative.
//
// Same product, different packs → same key:
//   "BULK-CITGARD 600 SAE 15/40 T/T"  → "citgard 600 sae 15/40"
//   "3/1 CASE-CITGARD 600 SAE 15/40"  → "citgard 600 sae 15/40"
//   "DRUM-CITGARD 600 SAE 15/40"      → "citgard 600 sae 15/40"
// Different products → different keys (identity numbers/grades preserved):
//   "CITGARD 600 30W" → "citgard 600 30w"  ≠  "citgard 600 sae 15/40"
//   "SUNVIS 846" / "868" / "832" stay distinct
export function underlyingProductKey(name: string): string {
  if (!name) return ''
  const work = splitPackPrefix(name)
  const tokens = work.split(/[^A-Za-z0-9/]+/).filter(Boolean)
  return stripPackaging(tokens).join(' ').toLowerCase().trim()
}

// A readable product name for a cluster: strip only the leading pack prefix and
// tidy whitespace, keeping the rest of the label as-is for legibility.
export function displayProductName(name: string): string {
  if (!name) return name
  return splitPackPrefix(name).replace(/\s+/g, ' ').trim()
}
