// Lightweight string similarity for fuzzy-matching product names to canonical
// items. Uses the Sorensen-Dice coefficient over character bigrams (0..1),
// with a small boost when categories agree. No external dependencies.

import { sameFoodGradeSegment } from './attributes'
import { attributeVerdict, deriveSpecKey, type ComparableItem } from './match-key'

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>()
  const clean = s.replace(/\s/g, '')
  for (let i = 0; i < clean.length - 1; i++) {
    const gram = clean.slice(i, i + 2)
    map.set(gram, (map.get(gram) ?? 0) + 1)
  }
  return map
}

/** Sorensen-Dice coefficient between two strings, 0 (none) .. 1 (identical). */
export function diceCoefficient(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0

  const aGrams = bigrams(na)
  const bGrams = bigrams(nb)
  let intersection = 0
  let aTotal = 0
  let bTotal = 0
  for (const count of aGrams.values()) aTotal += count
  for (const count of bGrams.values()) bTotal += count
  for (const [gram, countA] of aGrams) {
    const countB = bGrams.get(gram)
    if (countB) intersection += Math.min(countA, countB)
  }
  return (2 * intersection) / (aTotal + bTotal)
}

export type ScoredCandidate = {
  canonicalItemId: number
  score: number
  /** 'spec-key' for an exact attribute-tuple hit, 'fuzzy' for name similarity. */
  method: 'spec-key' | 'fuzzy'
}

export type MatchProduct = ComparableItem & { name: string }
export type MatchCandidate = ComparableItem & { id: number; name: string }

/**
 * Score a product against a list of canonical items and return the best match.
 *
 * Two tiers, in order:
 *   0. SPEC KEY — the product and exactly one candidate derive the same
 *      attribute tuple (category|grade|formulation). This is an identity
 *      assertion from structured data, so it wins outright with score 1 and
 *      needs no name similarity or LLM call. Requires a UNIQUE hit: several
 *      canonical items can share a tuple (269 such pairings in this catalog),
 *      and picking one arbitrarily would be a confident guess, not a match.
 *   1. FUZZY — Sorensen-Dice over names, with a small boost when categories
 *      agree, for everything the structured data can't settle.
 *
 * Candidates whose gating attributes conflict with the product's are vetoed
 * outright, alongside the pre-existing food-grade segment gate: a name can
 * look almost identical while the item is a different product type or grade
 * (a grease vs a circulating oil that share "460").
 */
export function bestMatch(
  product: MatchProduct,
  candidates: MatchCandidate[],
  threshold = 0.4,
): ScoredCandidate | null {
  // --- Tier 0: exact attribute-tuple identity -----------------------------
  const productKey = deriveSpecKey(product)
  if (productKey) {
    const keyed = candidates.filter(
      (c) => sameFoodGradeSegment(product, c) && deriveSpecKey(c) === productKey,
    )
    if (keyed.length === 1) {
      return { canonicalItemId: keyed[0].id, score: 1, method: 'spec-key' }
    }
  }

  // --- Tier 1: name similarity, with attribute vetoes ---------------------
  let best: ScoredCandidate | null = null
  for (const c of candidates) {
    // Never cross the food-grade / standard divide, no matter how similar the
    // names are (e.g. food-grade "Purity FG AW Hydraulic 46" vs a standard AW
    // hydraulic ISO 46).
    if (!sameFoodGradeSegment(product, c)) continue
    // Never match across a known category or grade difference. Unknown values
    // fall through so sparsely-attributed products still reach the fuzzy path.
    if (attributeVerdict(product, c).hasConflict) continue
    let score = diceCoefficient(product.name, c.name)
    if (
      product.category &&
      c.category &&
      normalize(product.category) === normalize(c.category)
    ) {
      score = Math.min(1, score + 0.1)
    }
    if (!best || score > best.score) {
      best = { canonicalItemId: c.id, score, method: 'fuzzy' }
    }
  }
  if (best && best.score >= threshold) return best
  return null
}
