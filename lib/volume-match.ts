import { bestMatch } from '@/lib/match'

// Shared auto-matching for purchase-volume rows, used both when a spreadsheet is
// first uploaded (app/api/volumes/route.ts) and when an existing import is
// re-matched after the catalog changes (rematchVolumeImport in
// app/actions/volumes.ts). Keeping it in one place means the upload and the
// re-match can never drift apart.

export type ProdTarget = {
  id: number
  name: string
  category: string | null
  sku: string | null
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

// Identity key for a NO-CODE row: the item name is its only identity, so
// compare on a lowercased, whitespace-collapsed, punctuation-stripped form.
// This is an EXACT identity (two names that normalize equal are the same item),
// never a fuzzy similarity — that distinction is the whole point of the fix.
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
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

// The catalog routinely holds several product rows for the same SKU (the same
// item reimported from successive price sheets). Those are duplicate records of
// one item, so a SKU key resolves to the first product in its group.
export type ResolvedTarget = { kind: 'product'; productId: number; name: string }

function resolveGroup(group: ProdTarget[]): ResolvedTarget | null {
  const p = group[0]
  return p ? { kind: 'product', productId: p.id, name: p.name } : null
}

// Precomputed lookup structures so matching a whole import is O(rows), not
// O(rows x products). Build once, pass to resolveMatch for every row.
export type MatchIndex = {
  prods: ProdTarget[]
  // Exact normalized SKU key -> resolved target (null when ambiguous).
  skuTargets: Map<string, ResolvedTarget | null>
  // Leading-zero-stripped numeric SKU key -> resolved target (null when
  // ambiguous). Reconciles codes that lost leading zeros in an Excel export.
  looseSkuTargets: Map<string, ResolvedTarget | null>
  // Exact normalized item NAME -> resolved target (null when ambiguous). Used
  // as the authoritative identity for rows that carry no vendor code.
  nameTargets: Map<string, ResolvedTarget | null>
}

export function buildMatchIndex(prods: ProdTarget[]): MatchIndex {
  // Group products by each key, then resolve each group to a single target.
  const bySkuGroup = new Map<string, ProdTarget[]>()
  const byLooseGroup = new Map<string, ProdTarget[]>()
  const byNameGroup = new Map<string, ProdTarget[]>()
  for (const p of prods) {
    const nk = normalizeName(p.name)
    if (nk) {
      const g = byNameGroup.get(nk)
      if (g) g.push(p)
      else byNameGroup.set(nk, [p])
    }
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
    skuTargets.set(k, resolveGroup(group))
  }
  const looseSkuTargets = new Map<string, ResolvedTarget | null>()
  for (const [k, group] of byLooseGroup) {
    looseSkuTargets.set(k, resolveGroup(group))
  }
  const nameTargets = new Map<string, ResolvedTarget | null>()
  for (const [k, group] of byNameGroup) {
    nameTargets.set(k, resolveGroup(group))
  }

  return {
    prods,
    skuTargets,
    looseSkuTargets,
    nameTargets,
  }
}

// Resolve a row's AUTHORITATIVE identity using exact signals only — never a
// fuzzy name similarity. This is the single rule the fix hinges on: a vendor
// code is the atomic unit of purchase history (one code = one item = one pack
// form), so distinct codes must never collapse onto one product. Order:
//   1. exact vendor code (from the SKU column or the item label), then
//      leading-zero-tolerant numeric code, then
//   2. for rows with NO code, the exact normalized item name.
// Returns the resolved target and which signal matched, or null when the row
// has no exact identity in the catalog (the caller then auto-creates a product
// keyed by the row's own code/name). An ambiguous key (target === null) short-
// circuits to null too — it is never downgraded to a looser guess.
export function resolveExactIdentity(
  row: VolumeMatchInput,
  index: MatchIndex,
): { target: ResolvedTarget; method: 'code' | 'name' } | null {
  const rowSku = row.sku?.trim() ? normalizeSku(row.sku) : ''
  const nameAsSku = row.itemName?.trim() ? normalizeSku(row.itemName) : ''
  const hasCode = Boolean(row.sku?.trim())

  for (const key of [rowSku, nameAsSku]) {
    if (!key) continue
    if (index.skuTargets.has(key)) {
      const t = index.skuTargets.get(key)
      if (t) return { target: t, method: 'code' }
      return null // present but ambiguous — do not fall through
    }
  }
  for (const candidate of [row.sku, row.itemName]) {
    if (!candidate?.trim()) continue
    const lk = looseSkuKey(candidate)
    if (lk && index.looseSkuTargets.has(lk)) {
      const t = index.looseSkuTargets.get(lk)
      if (t) return { target: t, method: 'code' }
      return null
    }
  }

  // Exact-name identity only for rows that genuinely have no vendor code. A
  // row WITH a code whose code isn't in the catalog is a distinct item to be
  // created under that code — it must not borrow another item's identity by
  // name.
  if (!hasCode) {
    const nk = row.itemName?.trim() ? normalizeName(row.itemName) : ''
    if (nk && index.nameTargets.has(nk)) {
      const t = index.nameTargets.get(nk)
      if (t) return { target: t, method: 'name' }
    }
  }

  return null
}

// Turn a resolved SKU target into a match result. A SKU hit is 'confirmed'
// because an exact vendor code is a deterministic identification that needs no
// human judgement.
function fromTarget(target: ResolvedTarget): VolumeMatchResult {
  return {
    canonicalItemId: null,
    productId: target.productId,
    matchName: target.name,
    matchStatus: 'confirmed',
    matchScore: 1,
  }
}

// Exact code match only (no item-name or fuzzy fallback). Codes are tried in
// order, so a purchasing system's own part number can be preferred over a
// secondary vendor part number. Returns the matched code with the result so
// the caller can store the code that identified the row.
export function matchByCode(
  codes: (string | null | undefined)[],
  index: MatchIndex,
): { result: VolumeMatchResult; code: string } | null {
  const present = codes.map((c) => c?.trim()).filter((c): c is string => Boolean(c))
  for (const code of present) {
    const t = index.skuTargets.get(normalizeSku(code))
    if (t) return { result: fromTarget(t), code }
  }
  for (const code of present) {
    const lk = looseSkuKey(code)
    const t = lk ? index.looseSkuTargets.get(lk) : undefined
    if (t) return { result: fromTarget(t), code }
  }
  return null
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

  // 2. Fuzzy name match (only meaningful when the item
  // label is an actual description). Surfaced as 'suggested' purely as an
  // ADVISORY hint for the review UI — it deliberately does NOT set
  // canonicalItemId/productId, so a fuzzy guess can never silently attach a row
  // to a different item's identity or reach the committed baseline. A reviewer
  // must explicitly confirm it (which sets the ids), or the commit will create
  // a standalone product for the row's own code/name.
  const product = { name: row.itemName, category: null as string | null }
  const prodHit = bestMatch(product, index.prods, 0.5)
  if (prodHit) {
    const hit = index.prods.find((p) => p.id === prodHit.canonicalItemId)
    return {
      canonicalItemId: null,
      productId: null,
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
