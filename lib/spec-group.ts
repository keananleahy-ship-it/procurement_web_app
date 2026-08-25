// Spec-tuple grouping: derive equivalence from the catalog's own attribute
// hierarchy (category > application > formulation > viscosity) instead of from
// a curated canonical item that something had to be MATCHED into.
//
// Why this exists alongside canonical items: matching is a guess that can be
// wrong, and auditing showed the curated layer failing in both directions at
// once — single canonical items lumping a grease with a turbine oil (they
// shared a grade number), while one real spec was fragmented across six
// different canonical items. A tuple has neither failure mode, because it is
// derived rather than asserted: two products group together only if their
// stated attributes actually agree.
//
// The dimension set is deliberately CONFIGURABLE rather than fixed. Equivalence
// is a judgement that changes with the question being asked:
//   - Tighten (add dimensions) to be certain a swap is like-for-like.
//   - Loosen (remove dimensions) to explore wider substitutions, e.g. dropping
//     formulation to see whether a synthetic could replace a conventional oil.
// A single hardcoded tuple would answer only one of those questions, and would
// also strand the ~58% of products with no viscosity recorded.
//
// Pure module: no DB or server imports, so the server action, the client UI,
// and any verification script all share exactly one definition of "same spec".

import { normalizeGrade, normalizeText } from '@/lib/match-key'

/**
 * The attributes that can participate in an equivalence key, ordered from
 * broadest to most specific — the same hierarchy the catalog-validation screen
 * uses, so the two screens describe identity the same way.
 */
export const SPEC_DIMENSIONS = [
  {
    key: 'category',
    label: 'Category',
    hint: 'Product type — grease vs gear oil vs hydraulic. Removing this compares across unrelated product types.',
  },
  {
    key: 'application',
    label: 'Application',
    hint: 'Intended service, e.g. Automotive or Industrial. Sparsely recorded, so including it narrows results sharply.',
  },
  {
    key: 'subcategory',
    label: 'Formulation',
    hint: 'Full synthetic vs blend vs conventional. Remove it to allow cross-formulation substitutions.',
  },
  {
    key: 'viscosity',
    label: 'Viscosity grade',
    hint: 'Normalized so ISO VG 46, ISO 46 and 15W-40 spellings collapse to one grade.',
  },
] as const

export type SpecDimension = (typeof SPEC_DIMENSIONS)[number]['key']

/**
 * Default key: category + formulation + viscosity.
 *
 * `application` is omitted by default because it is the sparsest and most
 * interpretive of the four — one vendor labels an oil "Industrial" and another
 * leaves it blank, which would split a genuine equivalence pair. It stays
 * available as a toggle for cases where the distinction matters.
 */
export const DEFAULT_SPEC_DIMENSIONS: SpecDimension[] = [
  'category',
  'subcategory',
  'viscosity',
]

export type SpecItem = {
  id: number
  name: string
  supplier: string | null
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
}

/** Normalized value for one dimension, or null when not recorded. */
export function specValue(
  item: SpecItem,
  dimension: SpecDimension,
): string | null {
  const raw = item[dimension]
  return dimension === 'viscosity' ? normalizeGrade(raw) : normalizeText(raw)
}

/**
 * Identity key for an item under the chosen dimensions, or null when the item
 * cannot be keyed.
 *
 * Every active dimension must be present. A missing value is an unknown, not a
 * wildcard: treating a blank viscosity as "matches anything" would silently
 * pool every unspecified product into one bogus equivalence group, which is
 * exactly the false-confidence failure this architecture replaces. Such items
 * are reported separately as unkeyable so the gap stays visible.
 */
export function specGroupKey(
  item: SpecItem,
  dimensions: SpecDimension[],
): string | null {
  if (dimensions.length === 0) return null
  const parts: string[] = []
  for (const dimension of dimensions) {
    const value = specValue(item, dimension)
    if (value == null) return null
    parts.push(`${dimension}=${value}`)
  }
  return parts.join('|')
}

export type SpecGroup = {
  key: string
  /** Human-readable spec, e.g. `Engine Oil · Full Synthetic · SAE 5W-30`. */
  label: string
  /** The raw (unnormalized) value per active dimension, for display. */
  values: { dimension: SpecDimension; value: string }[]
  items: SpecItem[]
  /** Distinct suppliers present, which is what makes a group actionable. */
  suppliers: string[]
  /**
   * Members with no supplier recorded (~30% of the catalog).
   *
   * Tracked separately because `suppliers.length` would otherwise overstate its
   * own completeness: a group listing one supplier may really span several, and
   * the "2+ suppliers" filter can therefore hide a genuine opportunity.
   */
  unattributed: number
}

export type SpecGrouping = {
  groups: SpecGroup[]
  /** Items that could not form a key because an active dimension was blank. */
  unkeyable: SpecItem[]
}

/**
 * Group items by their spec tuple under the chosen dimensions.
 *
 * Groups are returned widest-first (most suppliers, then most items), since a
 * spec carried by several vendors is where switching leverage actually is.
 */
export function groupBySpec(
  items: SpecItem[],
  dimensions: SpecDimension[],
): SpecGrouping {
  const byKey = new Map<string, SpecGroup>()
  const unkeyable: SpecItem[] = []

  for (const item of items) {
    const key = specGroupKey(item, dimensions)
    if (key == null) {
      unkeyable.push(item)
      continue
    }
    let group = byKey.get(key)
    if (!group) {
      // Label from the first member's raw values: shows the vendor's own
      // wording rather than the normalized form used for grouping.
      const values = dimensions
        .map((dimension) => ({ dimension, value: item[dimension] ?? '' }))
        .filter((v) => v.value !== '')
      group = {
        key,
        label: values.map((v) => v.value).join(' · '),
        values,
        items: [],
        suppliers: [],
        unattributed: 0,
      }
      byKey.set(key, group)
    }
    group.items.push(item)
  }

  const groups = [...byKey.values()]
  for (const group of groups) {
    const named = group.items
      .map((i) => i.supplier)
      .filter((s): s is string => s != null && s.trim() !== '')
    group.suppliers = [...new Set(named)].sort()
    group.unattributed = group.items.length - named.length
  }

  groups.sort(
    (a, b) =>
      b.suppliers.length - a.suppliers.length ||
      b.items.length - a.items.length ||
      a.label.localeCompare(b.label),
  )
  return { groups, unkeyable }
}

/**
 * The question asked directly: for one product, which OTHER products meet the
 * same spec but come from a different supplier.
 *
 * Same-supplier items are excluded because they are pack or branding variants
 * of a purchase already being made, not an alternative to it.
 */
export function findEquivalents(
  target: SpecItem,
  candidates: SpecItem[],
  dimensions: SpecDimension[],
): SpecItem[] {
  const key = specGroupKey(target, dimensions)
  if (key == null) return []
  const targetSupplier = normalizeText(target.supplier)
  return candidates.filter(
    (c) =>
      c.id !== target.id &&
      specGroupKey(c, dimensions) === key &&
      normalizeText(c.supplier) !== targetSupplier,
  )
}
