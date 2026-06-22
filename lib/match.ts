// Lightweight string similarity for fuzzy-matching product names to canonical
// items. Uses the Sorensen-Dice coefficient over character bigrams (0..1),
// with a small boost when categories agree. No external dependencies.

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
}

/**
 * Score a product against a list of canonical items and return the best match.
 * A matching category adds a small boost (capped at 1). Returns null when no
 * candidate clears the threshold.
 */
export function bestMatch(
  product: { name: string; category: string | null },
  candidates: { id: number; name: string; category: string | null }[],
  threshold = 0.4,
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null
  for (const c of candidates) {
    let score = diceCoefficient(product.name, c.name)
    if (
      product.category &&
      c.category &&
      normalize(product.category) === normalize(c.category)
    ) {
      score = Math.min(1, score + 0.1)
    }
    if (!best || score > best.score) {
      best = { canonicalItemId: c.id, score }
    }
  }
  if (best && best.score >= threshold) return best
  return null
}
