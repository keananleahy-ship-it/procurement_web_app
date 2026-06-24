'use server'

import { db } from '@/lib/db'
import { canonicalItems, products } from '@/lib/db/schema'
import { bestMatch } from '@/lib/match'
import { aiMatchProducts, aiDeriveSpecs } from '@/lib/match-ai'
import { requireUser, requireEditor } from '@/lib/roles'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

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
  await requireEditor()
  await db
    .update(products)
    .set({
      canonicalItemId,
      matchStatus: 'confirmed',
      matchScore: null,
      matchMethod: 'manual',
      matchReason: null,
    })
    .where(eq(products.id, productId))
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/** Clear a match entirely, returning the product to the unmatched pool. */
export async function resetMatch(productId: number) {
  await requireEditor()
  await db
    .update(products)
    .set({
      canonicalItemId: null,
      matchStatus: 'unmatched',
      matchScore: null,
      matchMethod: null,
      matchReason: null,
    })
    .where(eq(products.id, productId))
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

// Build a deterministic, brand-free grouping key from an AI-derived spec. Built
// in code (not by the model) so the same spec always yields the same key across
// batches. Strictness here = product kind + viscosity + performance grade +
// base type, keeping synthetic/conventional and different grades separate.
function specSignature(s: {
  productKind: string
  viscosity: string | null
  performanceGrade: string | null
  baseType: string
}): string {
  return [
    s.productKind?.trim().toLowerCase(),
    s.viscosity?.trim().toLowerCase() || '-',
    s.performanceGrade?.trim().toLowerCase() || '-',
    s.baseType && s.baseType !== 'unknown' ? s.baseType : '-',
  ].join('|')
}

const AUTO_GROUP_CHUNK = 50

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
    await db
      .update(products)
      .set({ matchMethod: null })
      .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))
  }

  const undecided = await db
    .select()
    .from(products)
    .where(notInArray(products.matchStatus, ['confirmed', 'rejected']))
    .orderBy(asc(products.id))

  const total = undecided.length
  // Products not yet stamped this run (we reuse matchMethod='ai' as the
  // processed marker so the loop always advances).
  const pendingThisRun = undecided.filter((p) => p.matchMethod !== 'ai')
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

  const specs = await aiDeriveSpecs(
    chunk.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit,
      baseUnit: p.baseUnit,
    })),
  )
  const specById = new Map(specs.map((s) => [s.productId, s]))

  // Load existing canonical items into a signature->id cache so equivalent
  // specs reuse the same canonical item instead of creating duplicates.
  const existing = await db.select().from(canonicalItems)
  const sigToId = new Map<string, number>()
  for (const c of existing) {
    // Canonical items created by this seeder store their signature in a stable
    // form; match on lowercased name as a fallback for hand-created items.
    sigToId.set(c.name.trim().toLowerCase(), c.id)
  }

  let grouped = 0
  let createdItems = 0
  const stampedNoSpec: number[] = []

  for (const p of chunk) {
    const spec = specById.get(p.id)
    if (!spec || !spec.productKind?.trim()) {
      // Spec batch failed for this product; stamp it processed so the loop
      // advances. A later reset run can retry it.
      stampedNoSpec.push(p.id)
      continue
    }

    const sig = specSignature(spec)
    const displayName = spec.displayName?.trim() || spec.productKind.trim()
    // Use the signature as the lookup key; fall back to display name dedupe.
    const cacheKey = sig
    let canonicalId = sigToId.get(cacheKey)

    if (!canonicalId) {
      const [created] = await db
        .insert(canonicalItems)
        .values({
          userId,
          name: displayName,
          category: spec.productKind.trim(),
          unit: p.unit ?? null,
          baseUnit: p.baseUnit ?? null,
        })
        .returning({ id: canonicalItems.id })
      canonicalId = created.id
      sigToId.set(cacheKey, canonicalId)
      sigToId.set(displayName.trim().toLowerCase(), canonicalId)
      createdItems++
    }

    await db
      .update(products)
      .set({
        canonicalItemId: canonicalId,
        matchStatus: 'suggested',
        matchScore: '0.9000',
        matchMethod: 'ai',
        matchReason: `Spec: ${displayName}`.slice(0, 280),
      })
      .where(eq(products.id, p.id))
    grouped++
  }

  if (stampedNoSpec.length > 0) {
    await db
      .update(products)
      .set({ matchMethod: 'ai' })
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
