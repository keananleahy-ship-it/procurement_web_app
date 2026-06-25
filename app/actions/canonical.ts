'use server'

import { db } from '@/lib/db'
import {
  canonicalItems,
  matchOverrides,
  products,
  vendorPrices,
  vendorTokenMappings,
} from '@/lib/db/schema'
import { bestMatch } from '@/lib/match'
import { aiMatchProducts } from '@/lib/match-ai'
import { parseProductSpec, normalizeNameKey } from '@/lib/spec-parse'
import { normalizeTier, type BaseOilTier } from '@/lib/oil-tier'
import { requireUser, requireEditor } from '@/lib/roles'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

// Build a per-product map of base-oil tier markers contributed by the vendors
// that sell each product. Vendors brand-code composition differently (e.g.
// Petro-Canada UHP/SHP/HP), and those codes are stored per-vendor in the
// nomenclature dictionary. We resolve each product's vendor(s) via its price
// rows and merge their oil_tier tokens, so spec parsing reads a product's name
// with its own vendor's vocabulary. Distinctive codes only appear in their
// owning vendor's names, so merging across a product's vendors is safe.
async function buildProductTierMarkers(
  productIds: number[],
): Promise<Map<number, Map<string, BaseOilTier>>> {
  const result = new Map<number, Map<string, BaseOilTier>>()
  if (productIds.length === 0) return result

  // vendorId -> (token -> tier)
  const tierRows = await db
    .select({
      vendorId: vendorTokenMappings.vendorId,
      token: vendorTokenMappings.token,
      value: vendorTokenMappings.value,
    })
    .from(vendorTokenMappings)
    .where(eq(vendorTokenMappings.kind, 'oil_tier'))
  if (tierRows.length === 0) return result

  const byVendor = new Map<number, Map<string, BaseOilTier>>()
  for (const r of tierRows) {
    const tier = normalizeTier(r.value)
    if (!tier) continue
    if (!byVendor.has(r.vendorId)) byVendor.set(r.vendorId, new Map())
    byVendor.get(r.vendorId)!.set(r.token.trim().toLowerCase(), tier)
  }
  if (byVendor.size === 0) return result

  // productId -> set of vendorIds
  const priceRows = await db
    .select({
      productId: vendorPrices.productId,
      vendorId: vendorPrices.vendorId,
    })
    .from(vendorPrices)
    .where(inArray(vendorPrices.productId, productIds))

  for (const pr of priceRows) {
    const vendorMarkers = byVendor.get(pr.vendorId)
    if (!vendorMarkers) continue
    if (!result.has(pr.productId)) result.set(pr.productId, new Map())
    const merged = result.get(pr.productId)!
    for (const [token, tier] of vendorMarkers) merged.set(token, tier)
  }
  return result
}

// Remember a manual matching decision so future auto-group runs re-apply it to
// the same product name. Upserts on (userId, productNameKey).
async function rememberOverride(
  userId: string,
  productName: string,
  canonicalItemId: number,
) {
  const productNameKey = normalizeNameKey(productName)
  if (!productNameKey) return
  await db
    .insert(matchOverrides)
    .values({ userId, productNameKey, canonicalItemId, sampleName: productName })
    .onConflictDoUpdate({
      target: [matchOverrides.userId, matchOverrides.productNameKey],
      set: { canonicalItemId, sampleName: productName, updatedAt: new Date() },
    })
}

export async function getCanonicalItems() {
  await requireUser()
  return db.select().from(canonicalItems).orderBy(asc(canonicalItems.name))
}

export async function createCanonicalItem(formData: FormData) {
  const { id: userId } = await requireEditor()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Canonical item name is required')
  const category = String(formData.get('category') ?? '').trim() || null
  const unit = String(formData.get('unit') ?? '').trim() || null
  const baseUnit =
    String(formData.get('baseUnit') ?? '').trim() || unit || null

  await db
    .insert(canonicalItems)
    .values({ userId, name, category, unit, baseUnit })
  revalidatePath('/canonical')
  revalidatePath('/matching')
}

export async function deleteCanonicalItem(id: number) {
  await requireEditor()
  // Detach any products pointing at this canonical item.
  await db
    .update(products)
    .set({ canonicalItemId: null, matchStatus: 'unmatched', matchScore: null })
    .where(eq(products.canonicalItemId, id))
  await db.delete(canonicalItems).where(eq(canonicalItems.id, id))
  revalidatePath('/canonical')
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/**
 * Recompute fuzzy-match suggestions for every product that has not yet been
 * confirmed or rejected. Confirmed/rejected products are left untouched so
 * human decisions are never overwritten.
 */
export async function generateSuggestions() {
  await requireEditor()
  const [items, prods] = await Promise.all([
    db.select().from(canonicalItems),
    db.select().from(products),
  ])

  const candidates = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
  }))

  let suggested = 0
  for (const p of prods) {
    if (p.matchStatus === 'confirmed' || p.matchStatus === 'rejected') continue
    const match = bestMatch(
      { name: p.name, category: p.category },
      candidates,
    )
    if (match) {
      await db
        .update(products)
        .set({
          canonicalItemId: match.canonicalItemId,
          matchStatus: 'suggested',
          matchScore: match.score.toFixed(4),
          matchMethod: 'fuzzy',
          matchReason: null,
        })
        .where(eq(products.id, p.id))
      suggested++
    } else {
      await db
        .update(products)
        .set({
          canonicalItemId: null,
          matchStatus: 'unmatched',
          matchScore: null,
          matchMethod: null,
          matchReason: null,
        })
        .where(eq(products.id, p.id))
    }
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { suggested }
}

// How many products one server-action call processes. Kept small so each call
// finishes well within the function time budget; the client loops across calls.
const AI_CHUNK_SIZE = 50

export type AiMatchProgress = {
  suggested: number
  cleared: number
  processed: number
  remaining: number
  total: number
  done: boolean
}

/**
 * AI-assisted second matching pass — chunked and resumable. Each call processes
 * up to AI_CHUNK_SIZE undecided products and reports progress so the client can
 * loop until the whole catalog is done, instead of trying to match everything
 * in one long-running request (which timed out partway, leaving most products
 * untouched). Results are staged as 'suggested'; confirmed/rejected products
 * are always preserved.
 *
 * Pass { reset: true } on the first call of a fresh run to clear the prior 'ai'
 * stamp on undecided products so they are reconsidered.
 */
export async function generateAiSuggestions(opts?: {
  reset?: boolean
  limit?: number
}): Promise<AiMatchProgress> {
  await requireEditor()
  const limit = Math.max(1, opts?.limit ?? AI_CHUNK_SIZE)

  // A fresh run clears the 'ai' processing stamp on undecided products so the
  // whole catalog is reconsidered. Confirmed/rejected decisions are untouched.
  if (opts?.reset) {
    await db
      .update(products)
      .set({ matchMethod: null })
      .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))
  }

  const items = await db.select().from(canonicalItems)
  const canonicalOptions = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    baseUnit: i.baseUnit,
  }))

  const undecided = await db
    .select()
    .from(products)
    .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))
    .orderBy(asc(products.id))

  const total = undecided.length
  if (total === 0 || canonicalOptions.length === 0) {
    return { suggested: 0, cleared: 0, processed: 0, remaining: 0, total, done: true }
  }

  // Products not yet stamped 'ai' in this run still need processing.
  const pendingThisRun = undecided.filter((p) => p.matchMethod !== 'ai')
  const chunk = pendingThisRun.slice(0, limit)
  if (chunk.length === 0) {
    return { suggested: 0, cleared: 0, processed: 0, remaining: 0, total, done: true }
  }

  const matches = await aiMatchProducts(
    chunk.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit,
      baseUnit: p.baseUnit,
    })),
    canonicalOptions,
  )

  const validCanonicalIds = new Set(canonicalOptions.map((c) => c.id))
  const byId = new Map(matches.map((m) => [m.productId, m]))

  let suggested = 0
  const clearedIds: number[] = []

  for (const p of chunk) {
    const m = byId.get(p.id)
    const hasMatch =
      m &&
      m.canonicalItemId !== null &&
      validCanonicalIds.has(m.canonicalItemId) &&
      m.confidence >= 0.5

    if (hasMatch && m) {
      await db
        .update(products)
        .set({
          canonicalItemId: m.canonicalItemId,
          matchStatus: 'suggested',
          matchScore: Math.max(0, Math.min(1, m.confidence)).toFixed(4),
          matchMethod: 'ai',
          matchReason: m.reason?.slice(0, 280) ?? null,
        })
        .where(eq(products.id, p.id))
      suggested++
    } else {
      // No confident match (or the product's AI batch was skipped). Stamp it
      // 'ai' anyway so the resumable loop always advances and never spins
      // forever; a later fresh run (reset) can reconsider it.
      clearedIds.push(p.id)
    }
  }

  if (clearedIds.length > 0) {
    await db
      .update(products)
      .set({
        canonicalItemId: null,
        matchStatus: 'unmatched',
        matchScore: null,
        matchMethod: 'ai',
        matchReason: null,
      })
      .where(inArray(products.id, clearedIds))
  }

  const processed = chunk.length
  const remaining = pendingThisRun.length - processed

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return {
    suggested,
    cleared: clearedIds.length,
    processed,
    remaining,
    total,
    done: remaining <= 0,
  }
}

export async function confirmMatch(productId: number) {
  await requireEditor()
  await db
    .update(products)
    .set({ matchStatus: 'confirmed' })
    .where(
      and(
        eq(products.id, productId),
        // Only confirm when there is something to confirm.
        inArray(products.matchStatus, ['suggested', 'rejected']),
      ),
    )
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

export async function rejectMatch(productId: number) {
  await requireEditor()
  await db
    .update(products)
    .set({
      matchStatus: 'rejected',
      canonicalItemId: null,
      matchScore: null,
      matchReason: null,
    })
    .where(eq(products.id, productId))
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/** Manually assign (or reassign) a product to a canonical item and confirm it. */
export async function assignMatch(productId: number, canonicalItemId: number) {
  const { id: userId } = await requireEditor()
  const [prod] = await db
    .update(products)
    .set({
      canonicalItemId,
      matchStatus: 'confirmed',
      matchScore: null,
      matchMethod: 'manual',
      matchReason: null,
    })
    .where(eq(products.id, productId))
    .returning({ name: products.name })

  // Learn from this decision: remember name -> canonical item for future runs.
  if (prod) await rememberOverride(userId, prod.name, canonicalItemId)

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/**
 * Create a brand-new canonical item and immediately assign the given product to
 * it (confirmed, manual). Used from the matching screen when none of the
 * existing canonical items fit, so the reviewer never has to leave the page.
 * Returns the new canonical item so the client can update its dropdown.
 */
export async function createCanonicalItemAndAssign(input: {
  productId: number
  name: string
  category?: string | null
}): Promise<{ id: number; name: string }> {
  const { id: userId } = await requireEditor()
  const name = input.name.trim()
  if (!name) throw new Error('Canonical item name is required')

  // Carry the product's unit/baseUnit onto the new item so per-unit price
  // normalization in the Compare view keeps working.
  const [prod] = await db
    .select({
      name: products.name,
      unit: products.unit,
      baseUnit: products.baseUnit,
    })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1)

  const category = input.category?.trim() || null
  const [created] = await db
    .insert(canonicalItems)
    .values({
      userId,
      name,
      category,
      unit: prod?.unit ?? null,
      baseUnit: prod?.baseUnit ?? prod?.unit ?? null,
    })
    .returning({ id: canonicalItems.id, name: canonicalItems.name })

  await db
    .update(products)
    .set({
      canonicalItemId: created.id,
      matchStatus: 'confirmed',
      matchScore: null,
      matchMethod: 'manual',
      matchReason: null,
    })
    .where(eq(products.id, input.productId))

  // Learn from this decision so the same product name maps here next time.
  if (prod?.name) await rememberOverride(userId, prod.name, created.id)

  revalidatePath('/matching')
  revalidatePath('/canonical')
  revalidatePath('/compare')
  revalidatePath('/')
  return created
}

/** Clear a match entirely, returning the product to the unmatched pool. */
export async function resetMatch(productId: number) {
  const { id: userId } = await requireEditor()
  const [prod] = await db
    .update(products)
    .set({
      canonicalItemId: null,
      matchStatus: 'unmatched',
      matchScore: null,
      matchMethod: null,
      matchReason: null,
    })
    .where(eq(products.id, productId))
    .returning({ name: products.name })

  // Forget any saved override for this product name so a reset truly clears the
  // decision and auto-group won't silently re-apply it next run.
  if (prod) {
    await db
      .delete(matchOverrides)
      .where(
        and(
          eq(matchOverrides.userId, userId),
          eq(matchOverrides.productNameKey, normalizeNameKey(prod.name)),
        ),
      )
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

const AUTO_GROUP_CHUNK = 200

export type AutoGroupProgress = {
  grouped: number
  createdItems: number
  processed: number
  remaining: number
  total: number
  done: boolean
}

/**
 * Seed the canonical catalog from the products themselves — chunked and
 * resumable. For each undecided product it derives a brand-free specification,
 * finds or creates a canonical item for that spec signature, and links the
 * product as a 'suggested' match. This makes cross-vendor, cross-brand
 * comparison possible when no canonical catalog has been built yet.
 *
 * Pass { reset: true } on the first call to reconsider all undecided products.
 */
export async function autoGroupProducts(opts?: {
  reset?: boolean
  limit?: number
}): Promise<AutoGroupProgress> {
  const { id: userId } = await requireEditor()
  const limit = Math.max(1, opts?.limit ?? AUTO_GROUP_CHUNK)

  if (opts?.reset) {
    // Detach every undecided product so it is fully reconsidered, then delete
    // any canonical item left with no products at all. This clears fragmented
    // single-vendor items from earlier runs while preserving anything the user
    // confirmed (those products keep their canonical link).
    await db
      .update(products)
      .set({
        matchMethod: null,
        canonicalItemId: null,
        matchStatus: 'unmatched',
        matchScore: null,
        matchReason: null,
      })
      .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))

    const referenced = await db
      .selectDistinct({ id: products.canonicalItemId })
      .from(products)
    const keepIds = referenced
      .map((r) => r.id)
      .filter((id): id is number => id !== null)
    if (keepIds.length > 0) {
      await db
        .delete(canonicalItems)
        .where(notInArray(canonicalItems.id, keepIds))
    } else {
      await db.delete(canonicalItems)
    }
  }

  const undecided = await db
    .select()
    .from(products)
    .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))
    .orderBy(asc(products.id))

  const total = undecided.length
  // Products not yet stamped this run (we reuse matchMethod='spec' as the
  // processed marker so the loop always advances).
  const pendingThisRun = undecided.filter((p) => p.matchMethod !== 'spec')
  const chunk = pendingThisRun.slice(0, limit)
  if (chunk.length === 0) {
    return {
      grouped: 0,
      createdItems: 0,
      processed: 0,
      remaining: 0,
      total,
      done: true,
    }
  }

  // Load existing canonical items into a signature->id cache so equivalent
  // specs reuse the same canonical item instead of creating duplicates. Items
  // created by this grouper store their exact signature in specKey; for
  // confirmed/hand-made items we best-effort derive one by parsing the name.
  const existing = await db.select().from(canonicalItems)
  const sigToId = new Map<string, number>()
  for (const c of existing) {
    const sig = c.specKey ?? parseProductSpec(c.name)?.specKey
    if (sig && !sigToId.has(sig)) sigToId.set(sig, c.id)
  }

  // Load remembered manual decisions and apply them first. Any product whose
  // normalized name matches a saved override is assigned to that canonical item
  // automatically (the reviewer already made this call once). Overrides that
  // point at a canonical item that no longer exists are ignored.
  const validCanonical = new Set(existing.map((c) => c.id))
  const overrides = await db
    .select()
    .from(matchOverrides)
    .where(eq(matchOverrides.userId, userId))
  const overrideByKey = new Map<string, number>()
  for (const o of overrides) {
    if (validCanonical.has(o.canonicalItemId)) {
      overrideByKey.set(o.productNameKey, o.canonicalItemId)
    }
  }

  // Per-product vendor oil-tier markers so each name is parsed with its own
  // vendor's composition vocabulary.
  const tierMarkers = await buildProductTierMarkers(chunk.map((p) => p.id))

  let grouped = 0
  let createdItems = 0
  // Products whose names yield no reliable spec (ATF, grease, antifreeze, etc.)
  // are not auto-grouped per the chosen policy; we stamp them processed so the
  // resumable loop advances and leave them unmatched for manual grouping.
  const stampedNoSpec: number[] = []

  for (const p of chunk) {
    // 1) Saved manual decision wins: re-apply the reviewer's earlier choice.
    const overrideId = overrideByKey.get(normalizeNameKey(p.name))
    if (overrideId !== undefined) {
      await db
        .update(products)
        .set({
          canonicalItemId: overrideId,
          matchStatus: 'confirmed',
          matchScore: null,
          matchMethod: 'manual',
          matchReason: 'Applied from your saved assignment',
        })
        .where(eq(products.id, p.id))
      grouped++
      continue
    }

    // 2) Otherwise derive a spec from the name and group by signature, reading
    // the name with this product's vendor oil-tier vocabulary.
    const spec = parseProductSpec(p.name, {
      oilTierMarkers: tierMarkers.get(p.id),
    })
    if (!spec) {
      stampedNoSpec.push(p.id)
      continue
    }

    const sig = spec.specKey
    let canonicalId = sigToId.get(sig)

    if (!canonicalId) {
      const [created] = await db
        .insert(canonicalItems)
        .values({
          userId,
          name: spec.displayName,
          category: spec.category,
          unit: p.unit ?? null,
          baseUnit: p.baseUnit ?? null,
          specKey: sig,
        })
        .returning({ id: canonicalItems.id })
      canonicalId = created.id
      sigToId.set(sig, canonicalId)
      createdItems++
    }

    await db
      .update(products)
      .set({
        canonicalItemId: canonicalId,
        matchStatus: 'suggested',
        matchScore: '0.9000',
        matchMethod: 'spec',
        matchReason: `Spec match: ${spec.displayName}`.slice(0, 280),
      })
      .where(eq(products.id, p.id))
    grouped++
  }

  if (stampedNoSpec.length > 0) {
    await db
      .update(products)
      .set({ matchMethod: 'spec' })
      .where(inArray(products.id, stampedNoSpec))
  }

  const processed = chunk.length
  const remaining = pendingThisRun.length - processed

  revalidatePath('/matching')
  revalidatePath('/canonical')
  revalidatePath('/compare')
  revalidatePath('/')
  return {
    grouped,
    createdItems,
    processed,
    remaining,
    total,
    done: remaining <= 0,
  }
}

export type MatchRow = {
  productId: number
  productName: string
  category: string | null
  unit: string | null
  packSize: number
  baseUnit: string | null
  matchStatus: string
  matchScore: number | null
  matchMethod: string | null
  matchReason: string | null
  canonicalItemId: number | null
  canonicalItemName: string | null
}

/** Products joined with their (suggested or confirmed) canonical item. */
export async function getMatchRows(): Promise<MatchRow[]> {
  await requireUser()
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      category: products.category,
      unit: products.unit,
      packSize: products.packSize,
      baseUnit: products.baseUnit,
      matchStatus: products.matchStatus,
      matchScore: products.matchScore,
      matchMethod: products.matchMethod,
      matchReason: products.matchReason,
      canonicalItemId: products.canonicalItemId,
      canonicalItemName: canonicalItems.name,
    })
    .from(products)
    .leftJoin(canonicalItems, eq(canonicalItems.id, products.canonicalItemId))
    .orderBy(asc(products.name))

  return rows.map((r) => ({
    ...r,
    packSize: Number(r.packSize ?? 1),
    matchScore: r.matchScore === null ? null : Number(r.matchScore),
  }))
}
