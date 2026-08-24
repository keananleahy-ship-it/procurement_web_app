// Attribute-based comparison for product <-> canonical-item matching.
//
// Matching historically compared product NAMES as strings (Sorensen-Dice over
// bigrams), with category worth only a small score boost. That let grade
// numbers dominate identity and produced confident nonsense: a grease matched
// to a circulating oil because both said "460", an EP gear compound matched to
// an R&O circulating oil because both said "220".
//
// The catalog-validation screen already settled item identity as a TUPLE of
// attributes (category > application > formulation > viscosity). This module
// makes that same tuple available to matching, so the structured columns both
// tables already carry can gate a match instead of merely nudging its score.
//
// Deliberately free of DB and server imports: pure functions, shared by the
// fuzzy matcher, the AI pass, the server actions, and the client grid.

export type AttributeComparison = 'agree' | 'conflict' | 'unknown'

// The attributes compared when judging whether two items are the same thing.
// `packageType` is excluded on purpose: a canonical item spans pack sizes, so
// pack differences must never block a match. `supplier`/`brand` are excluded
// because the whole point is comparing across vendors and brands.
export const COMPARED_ATTRIBUTES = [
  'category',
  'application',
  'subcategory',
  'viscosity',
] as const

export type ComparedAttribute = (typeof COMPARED_ATTRIBUTES)[number]

// Only these two may VETO a match.
//
// `category` is the product type (grease vs gear oil vs hydraulic) and
// `viscosity` is the grade — together they are what a buyer means by "the same
// item". `application` and `subcategory` are advisory: they are sparser and
// more interpretive (an oil may be legitimately labelled Industrial by one
// vendor and left blank by another), so gating on them would suppress
// legitimate matches. They are still shown to reviewers and to the model.
const GATING_ATTRIBUTES: ComparedAttribute[] = ['category', 'viscosity']

export type ComparableItem = {
  name?: string | null
  category?: string | null
  application?: string | null
  subcategory?: string | null
  viscosity?: string | null
}

/** Case/punctuation-insensitive form of a plain text attribute value. */
function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return out || null
}

/**
 * Canonical form of a viscosity/grade designation, so the same grade written
 * different ways collapses to one value: `ISO VG 46`, `ISO 46` and `iso-46`
 * all become `iso46`; `15W-40` and `SAE 15W40` both become `sae15w40`.
 *
 * Grade is parsed by family rather than string-stripped, because stripping
 * punctuation alone would leave `isovg46` and `iso46` unequal — and a false
 * "conflict" is worse than no opinion, since it would veto a real match.
 */
export function normalizeGrade(value: string | null | undefined): string | null {
  if (value == null) return null
  const raw = value.toLowerCase()

  // SAE multigrade: 15W-40, 15w40, SAE 0W-20, 80W-140.
  const multigrade = raw.match(/\b(\d{1,2})\s*w\s*-?\s*(\d{1,3})(?!\d)/)
  if (multigrade) {
    return `sae${Number(multigrade[1])}w${Number(multigrade[2])}`
  }

  // SAE straight grade with a winter marker: 10W, 30W.
  const straightWinter = raw.match(/\b(\d{1,2})\s*w\b/)
  if (straightWinter) return `sae${Number(straightWinter[1])}w`

  // Explicit SAE monograde: SAE 30, SAE 40.
  if (/\bsae\b/.test(raw)) {
    const monograde = raw.match(/(\d{1,3})/)
    if (monograde) return `sae${Number(monograde[1])}`
  }

  // NLGI grease consistency grade: NLGI 2, NLGI #2.
  const nlgi = raw.match(/nlgi\s*#?\s*(\d)/)
  if (nlgi) return `nlgi${Number(nlgi[1])}`

  // ISO VG and bare industrial grades: "ISO VG 220", "220".
  const iso = raw.match(/(\d{1,4})/)
  if (iso) return `iso${Number(iso[1])}`

  return normalizeText(raw)?.replace(/\s+/g, '') ?? null
}

/**
 * A structured identity key for an item, derived from its own attributes.
 *
 * NOTE: `canonical_items.specKey` stores keys from an earlier design in a
 * different vocabulary (e.g. `engine oil pc|0w-20|full-synthetic`, where
 * "pc" folds in the application). Those legacy strings are NOT reproducible
 * from the current columns, so we derive the key for BOTH sides here instead
 * of reading the stored one. Deriving both sides is what makes the comparison
 * symmetric and trustworthy; reading a legacy key for one side only would
 * silently never match.
 *
 * Returns null unless both category and viscosity are known, since a key
 * missing either half cannot assert identity.
 */
export function deriveSpecKey(item: ComparableItem): string | null {
  const category = normalizeText(item.category)
  const grade = normalizeGrade(item.viscosity)
  if (!category || !grade) return null
  const formulation = normalizeText(item.subcategory) ?? 'any'
  return `${category}|${grade}|${formulation}`
}

/** Compare one attribute across two items. */
export function compareAttribute(
  key: ComparedAttribute,
  a: ComparableItem,
  b: ComparableItem,
): AttributeComparison {
  const normalize = key === 'viscosity' ? normalizeGrade : normalizeText
  const left = normalize(a[key])
  const right = normalize(b[key])
  // A missing value is an unknown, not a disagreement. Attribute coverage is
  // uneven (category ~79%, viscosity ~42%), so treating null as a conflict
  // would block most of the catalog from matching at all.
  if (left == null || right == null) return 'unknown'
  return left === right ? 'agree' : 'conflict'
}

export type AttributeVerdict = {
  attributes: Record<ComparedAttribute, AttributeComparison>
  /** True when a GATING attribute is known on both sides and disagrees. */
  hasConflict: boolean
  /** The gating attributes that disagree, for display and audit messages. */
  conflicting: ComparedAttribute[]
}

/**
 * Compare every attribute of a product against a candidate canonical item and
 * decide whether the pairing is vetoed.
 */
export function attributeVerdict(
  product: ComparableItem,
  candidate: ComparableItem,
): AttributeVerdict {
  const attributes = {} as Record<ComparedAttribute, AttributeComparison>
  for (const key of COMPARED_ATTRIBUTES) {
    attributes[key] = compareAttribute(key, product, candidate)
  }
  const conflicting = GATING_ATTRIBUTES.filter(
    (key) => attributes[key] === 'conflict',
  )
  return { attributes, hasConflict: conflicting.length > 0, conflicting }
}

/** Human-readable reason for a vetoed pairing, for match reasons and audits. */
export function describeConflict(
  verdict: AttributeVerdict,
  product: ComparableItem,
  candidate: ComparableItem,
): string {
  const parts = verdict.conflicting.map(
    (key) => `${key} ${product[key] ?? '-'} vs ${candidate[key] ?? '-'}`,
  )
  return `Blocked: ${parts.join('; ')}`
}
