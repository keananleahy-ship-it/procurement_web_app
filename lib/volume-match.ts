import { bestMatch } from '@/lib/match'

// Shared auto-matching for purchase-volume rows, used both when a spreadsheet is
// first uploaded (app/api/volumes/route.ts) and when an existing import is
// re-matched after the catalog changes (rematchVolumeImport in
// app/actions/volumes.ts). Keeping it in one place means the upload and the
// re-match can never drift apart.

export type CanonTarget = { id: number; name: string; category: string | null }
export type ProdTarget = {
  id: number
  name: string
  category: string | null
  sku: string | null
  canonicalItemId: number | null
}

// The minimal shape the matcher needs from a row: the item label and, when the
// sheet had a dedicated SKU column, its value.
export type VolumeMatchInput = { itemName: string; sku: string | null }

export type VolumeMatchResult = {
  canonicalItemId: number | null
  productId: number | null
  matchName: string | null
  matchStatus: 'suggested' | 'confirmed' | 'unmatched'
  matchScore: number | null
}

// SKUs vary in punctuation/spacing/case between systems (e.g. "TK-68 205L" vs
// "tk68205l"), so compare on an alphanumeric-only, lowercased form.
export function normalizeSku(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Precomputed lookup structures so matching a whole import is O(rows), not
// O(rows x products). Build once, pass to resolveMatch for every row.
export type MatchIndex = {
  canon: CanonTarget[]
  prods: ProdTarget[]
  canonById: Map<number, CanonTarget>
  // normalized SKU -> product (first product wins on collision)
  prodBySku: Map<string, ProdTarget>
}

export function buildMatchIndex(
  canon: CanonTarget[],
  prods: ProdTarget[],
): MatchIndex {
  const canonById = new Map(canon.map((c) => [c.id, c]))
  const prodBySku = new Map<string, ProdTarget>()
  for (const p of prods) {
    if (p.sku && p.sku.trim()) {
      const k = normalizeSku(p.sku)
      if (k && !prodBySku.has(k)) prodBySku.set(k, p)
    }
  }
  return { canon, prods, canonById, prodBySku }
}

// Resolve a product SKU hit into a match result. A SKU hit resolves up to the
// product's canonical item when one is linked (so the volume spans every vendor
// offering that item) and is marked 'confirmed' since an exact vendor code is a
// deterministic identification that needs no human judgement.
function fromSkuHit(hit: ProdTarget, index: MatchIndex): VolumeMatchResult {
  if (hit.canonicalItemId !== null) {
    const c = index.canonById.get(hit.canonicalItemId)
    return {
      canonicalItemId: hit.canonicalItemId,
      productId: null,
      matchName: c?.name ?? hit.name,
      matchStatus: 'confirmed',
      matchScore: 1,
    }
  }
  return {
    canonicalItemId: null,
    productId: hit.id,
    matchName: hit.name,
    matchStatus: 'confirmed',
    matchScore: 1,
  }
}

export function resolveMatch(
  row: VolumeMatchInput,
  index: MatchIndex,
): VolumeMatchResult {
  // 1a. Exact vendor SKU from a dedicated SKU column.
  const rowSku = row.sku?.trim() ? normalizeSku(row.sku) : ''
  if (rowSku) {
    const hit = index.prodBySku.get(rowSku)
    if (hit) return fromSkuHit(hit, index)
  }

  // 1b. Many purchasing exports put the vendor item CODE in the item column
  // rather than a description, so try the item label as a SKU candidate too.
  const nameAsSku = row.itemName?.trim() ? normalizeSku(row.itemName) : ''
  if (nameAsSku && nameAsSku !== rowSku) {
    const hit = index.prodBySku.get(nameAsSku)
    if (hit) return fromSkuHit(hit, index)
  }

  // 2. Fuzzy name match, canonical items first (only meaningful when the item
  // label is an actual description). Surfaced as 'suggested' for review.
  const product = { name: row.itemName, category: null as string | null }
  const canonHit = bestMatch(product, index.canon, 0.5)
  if (canonHit) {
    const hit = index.canonById.get(canonHit.canonicalItemId)
    return {
      canonicalItemId: canonHit.canonicalItemId,
      productId: null,
      matchName: hit?.name ?? null,
      matchStatus: 'suggested',
      matchScore: canonHit.score,
    }
  }
  const prodHit = bestMatch(product, index.prods, 0.5)
  if (prodHit) {
    const hit = index.prods.find((p) => p.id === prodHit.canonicalItemId)
    return {
      canonicalItemId: null,
      productId: prodHit.canonicalItemId,
      matchName: hit?.name ?? null,
      matchStatus: 'suggested',
      matchScore: prodHit.score,
    }
  }
  return {
    canonicalItemId: null,
    productId: null,
    matchName: null,
    matchStatus: 'unmatched',
    matchScore: null,
  }
}
