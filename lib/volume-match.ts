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

// Looser SKU key that also drops leading zeros, but ONLY when the normalized
// SKU is entirely numeric. Purchasing exports (especially anything that has
// passed through Excel) silently strip leading zeros from numeric-looking
// codes, so a price-sheet SKU "01059065" arrives in the volume file as
// "1059065". Stripping leading zeros on both sides reconciles them. We restrict
// this to purely-numeric SKUs so we never conflate distinct alphanumeric codes.
export function looseSkuKey(s: string): string | null {
  const n = normalizeSku(s)
  if (!n || !/^[0-9]+$/.test(n)) return null
  return n.replace(/^0+/, '') || '0'
}

// The catalog routinely holds several product rows for the same SKU — the same
// item reimported from successive price sheets with slightly different name
// formatting, sometimes one copy linked to a canonical item and its duplicates
// not. So a SKU key maps to a *group* of products, which we resolve to a single
// target: the canonical item when the group points to exactly one, otherwise a
// representative product. Only when a group spans two genuinely different
// canonical items is it ambiguous (null) and left for manual review.
export type ResolvedTarget =
  | { kind: 'canonical'; canonicalItemId: number; name: string }
  | { kind: 'product'; productId: number; name: string }

function resolveGroup(
  group: ProdTarget[],
  canonById: Map<number, CanonTarget>,
): ResolvedTarget | null {
  const distinctCanon = [
    ...new Set(
      group
        .filter((p) => p.canonicalItemId !== null)
        .map((p) => p.canonicalItemId as number),
    ),
  ]
  if (distinctCanon.length === 1) {
    const id = distinctCanon[0]
    return {
      kind: 'canonical',
      canonicalItemId: id,
      name: canonById.get(id)?.name ?? group[0].name,
    }
  }
  if (distinctCanon.length === 0) {
    // All copies are standalone (no canonical link) — duplicate records of the
    // same item, so attach to the first. (In the compare view standalone
    // products don't merge across vendors anyway.)
    const p = group[0]
    return { kind: 'product', productId: p.id, name: p.name }
  }
  // Two or more distinct canonical items share this code: genuinely ambiguous.
  return null
}

// Precomputed lookup structures so matching a whole import is O(rows), not
// O(rows x products). Build once, pass to resolveMatch for every row.
export type MatchIndex = {
  canon: CanonTarget[]
  prods: ProdTarget[]
  canonById: Map<number, CanonTarget>
  // Exact normalized SKU key -> resolved target (null when ambiguous).
  skuTargets: Map<string, ResolvedTarget | null>
  // Leading-zero-stripped numeric SKU key -> resolved target (null when
  // ambiguous). Reconciles codes that lost leading zeros in an Excel export.
  looseSkuTargets: Map<string, ResolvedTarget | null>
}

export function buildMatchIndex(
  canon: CanonTarget[],
  prods: ProdTarget[],
): MatchIndex {
  const canonById = new Map(canon.map((c) => [c.id, c]))

  // Group products by each key, then resolve each group to a single target.
  const bySkuGroup = new Map<string, ProdTarget[]>()
  const byLooseGroup = new Map<string, ProdTarget[]>()
  for (const p of prods) {
    if (!p.sku || !p.sku.trim()) continue
    const k = normalizeSku(p.sku)
    if (k) {
      const g = bySkuGroup.get(k)
      if (g) g.push(p)
      else bySkuGroup.set(k, [p])
    }
    const lk = looseSkuKey(p.sku)
    if (lk) {
      const g = byLooseGroup.get(lk)
      if (g) g.push(p)
      else byLooseGroup.set(lk, [p])
    }
  }

  const skuTargets = new Map<string, ResolvedTarget | null>()
  for (const [k, group] of bySkuGroup) {
    skuTargets.set(k, resolveGroup(group, canonById))
  }
  const looseSkuTargets = new Map<string, ResolvedTarget | null>()
  for (const [k, group] of byLooseGroup) {
    looseSkuTargets.set(k, resolveGroup(group, canonById))
  }

  return { canon, prods, canonById, skuTargets, looseSkuTargets }
}

// Turn a resolved SKU target into a match result. A SKU hit is 'confirmed'
// because an exact vendor code is a deterministic identification that needs no
// human judgement; canonical targets let the volume span every vendor offering
// that item.
function fromTarget(target: ResolvedTarget): VolumeMatchResult {
  if (target.kind === 'canonical') {
    return {
      canonicalItemId: target.canonicalItemId,
      productId: null,
      matchName: target.name,
      matchStatus: 'confirmed',
      matchScore: 1,
    }
  }
  return {
    canonicalItemId: null,
    productId: target.productId,
    matchName: target.name,
    matchStatus: 'confirmed',
    matchScore: 1,
  }
}

export function resolveMatch(
  row: VolumeMatchInput,
  index: MatchIndex,
): VolumeMatchResult {
  // 1. Vendor-SKU matching, in decreasing confidence. Both the dedicated SKU
  // column and the item label are tried against each index, because many
  // purchasing exports put the vendor item CODE in the item column rather than
  // a description. Exact keys are preferred over leading-zero-tolerant ones. A
  // key that is present but ambiguous (null target) does NOT fall through to a
  // looser guess — it means the code genuinely maps to two different items.
  const rowSku = row.sku?.trim() ? normalizeSku(row.sku) : ''
  const nameAsSku = row.itemName?.trim() ? normalizeSku(row.itemName) : ''

  for (const key of [rowSku, nameAsSku]) {
    if (!key) continue
    if (index.skuTargets.has(key)) {
      const t = index.skuTargets.get(key)
      if (t) return fromTarget(t)
    }
  }
  for (const candidate of [row.sku, row.itemName]) {
    if (!candidate?.trim()) continue
    const lk = looseSkuKey(candidate)
    if (lk && index.looseSkuTargets.has(lk)) {
      const t = index.looseSkuTargets.get(lk)
      if (t) return fromTarget(t)
    }
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
