'use server'

import { db } from '@/lib/db'
import {
  canonicalItems,
  matchRejectionFeedback,
  products,
} from '@/lib/db/schema'
import { bestMatch } from '@/lib/match'
import { aiMatchProducts } from '@/lib/match-ai'
import { requireUser, requireEditor } from '@/lib/roles'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
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

/**
 * AI-assisted second matching pass. Reasons over product + canonical lists to
 * catch synonyms and pack-size variants the fuzzy pass misses. Every result is
 * staged as a 'suggested' match (never auto-confirmed); confirmed/rejected
 * products are left untouched so human decisions are preserved.
 */
export async function generateAiSuggestions() {
  await requireEditor()
  const [items, prods, feedback] = await Promise.all([
    db.select().from(canonicalItems),
    db.select().from(products),
    db
      .select()
      .from(matchRejectionFeedback)
      .orderBy(desc(matchRejectionFeedback.createdAt))
      .limit(200),
  ])

  const canonicalOptions = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    baseUnit: i.baseUnit,
  }))

  // Only reconsider products the user has not already decided on.
  const pending = prods.filter(
    (p) => p.matchStatus !== 'confirmed' && p.matchStatus !== 'rejected',
  )
  if (pending.length === 0 || canonicalOptions.length === 0) {
    return { suggested: 0, cleared: 0 }
  }

  const matches = await aiMatchProducts(
    pending.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit,
      baseUnit: p.baseUnit,
    })),
    canonicalOptions,
    feedback.map((f) => ({
      productName: f.productName,
      rejectedCanonicalName: f.canonicalItemName,
      note: f.note,
    })),
  )

  const validCanonicalIds = new Set(canonicalOptions.map((c) => c.id))
  const byId = new Map(matches.map((m) => [m.productId, m]))

  let suggested = 0
  let cleared = 0
  let skipped = 0
  for (const p of pending) {
    const m = byId.get(p.id)

    // If the AI returned no entry for this product, its batch failed (e.g. a
    // provider rate limit). Leave the product as-is rather than wrongly marking
    // it unmatched, so a partial run never wipes existing matches. It will be
    // reconsidered on the next run.
    if (!m) {
      skipped++
      continue
    }

    const hasMatch =
      m.canonicalItemId !== null &&
      validCanonicalIds.has(m.canonicalItemId) &&
      m.confidence >= 0.5

    if (hasMatch) {
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
      await db
        .update(products)
        .set({
          canonicalItemId: null,
          matchStatus: 'unmatched',
          matchScore: null,
          matchMethod: 'ai',
          matchReason: m.reason?.slice(0, 280) ?? null,
        })
        .where(eq(products.id, p.id))
      cleared++
    }
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { suggested, cleared, skipped }
}

/**
 * Reconsider rejected products through the AI pass, using the rejection notes
 * the user left. A product is re-surfaced to the review list ('suggested') only
 * when the AI finds a confident match to a DIFFERENT canonical item — never one
 * the product was already rejected from. Products without a better match stay
 * rejected. This is how user feedback on a rejection updates the recommendation.
 */
export async function rematchRejected() {
  await requireEditor()
  const [items, prods, feedback] = await Promise.all([
    db.select().from(canonicalItems),
    db.select().from(products),
    db
      .select()
      .from(matchRejectionFeedback)
      .orderBy(desc(matchRejectionFeedback.createdAt))
      .limit(500),
  ])

  const rejected = prods.filter((p) => p.matchStatus === 'rejected')
  const canonicalOptions = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    baseUnit: i.baseUnit,
  }))
  if (rejected.length === 0 || canonicalOptions.length === 0) {
    return { resuggested: 0 }
  }

  // For each product, the set of canonical items it was previously rejected
  // from. The new suggestion must avoid these so we never re-propose a pairing
  // the user already turned down.
  const rejectedByProduct = new Map<number, Set<number>>()
  for (const f of feedback) {
    if (f.canonicalItemId === null) continue
    if (!rejectedByProduct.has(f.productId)) {
      rejectedByProduct.set(f.productId, new Set())
    }
    rejectedByProduct.get(f.productId)!.add(f.canonicalItemId)
  }

  const matches = await aiMatchProducts(
    rejected.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit,
      baseUnit: p.baseUnit,
    })),
    canonicalOptions,
    feedback.map((f) => ({
      productName: f.productName,
      rejectedCanonicalName: f.canonicalItemName,
      note: f.note,
    })),
  )

  const validCanonicalIds = new Set(canonicalOptions.map((c) => c.id))
  const byId = new Map(matches.map((m) => [m.productId, m]))

  let resuggested = 0
  for (const p of rejected) {
    const m = byId.get(p.id)
    const previouslyRejected = rejectedByProduct.get(p.id) ?? new Set<number>()
    const isNewConfidentMatch =
      m &&
      m.canonicalItemId !== null &&
      validCanonicalIds.has(m.canonicalItemId) &&
      !previouslyRejected.has(m.canonicalItemId) &&
      m.confidence >= 0.5

    if (!isNewConfidentMatch) continue

    await db
      .update(products)
      .set({
        canonicalItemId: m!.canonicalItemId,
        matchStatus: 'suggested',
        matchScore: Math.max(0, Math.min(1, m!.confidence)).toFixed(4),
        matchMethod: 'ai',
        matchReason: m!.reason?.slice(0, 280) ?? null,
      })
      .where(eq(products.id, p.id))
    resuggested++
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { resuggested }
}

export async function confirmMatch(productId: number) {
  await requireEditor()

  // Look up which canonical item this product is matched to. A canonical item
  // represents a single product that vendors sell in many pack sizes, and each
  // pack size is a separate product row pointing at the same canonical item.
  const [target] = await db
    .select({ canonicalItemId: products.canonicalItemId })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)

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

  // Confirming one pack size confirms them all: every other product mapped to
  // the same canonical item that is still awaiting review is auto-confirmed.
  // Rejected products (canonicalItemId is cleared on reject) and already
  // confirmed ones are left untouched, so prior decisions are preserved.
  let cascaded = 0
  if (target?.canonicalItemId != null) {
    const siblings = await db
      .update(products)
      .set({ matchStatus: 'confirmed' })
      .where(
        and(
          eq(products.canonicalItemId, target.canonicalItemId),
          eq(products.matchStatus, 'suggested'),
        ),
      )
      .returning({ id: products.id })
    cascaded = siblings.length
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  // `confirmed` counts every product moved to confirmed: the target plus any
  // other pack sizes of the same item that were still pending.
  return { confirmed: 1 + cascaded }
}

export async function rejectMatch(productId: number, note?: string) {
  const { id: userId } = await requireEditor()

  // Read the product (and its current canonical item) BEFORE clearing the
  // suggestion. We need the canonical id both to record feedback and to cascade
  // the rejection to the item's other pack sizes.
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)

  const canonicalItemId = product?.canonicalItemId ?? null
  let canonicalItemName: string | null = null
  if (canonicalItemId !== null) {
    const [ci] = await db
      .select({ name: canonicalItems.name })
      .from(canonicalItems)
      .where(eq(canonicalItems.id, canonicalItemId))
      .limit(1)
    canonicalItemName = ci?.name ?? null
  }

  // Capture feedback (if a note was given) recording which canonical item the
  // user said was wrong and why. This row persists even if the product is later
  // re-matched, and feeds the AI pass.
  const trimmedNote = (note ?? '').trim()
  if (trimmedNote && product) {
    await db.insert(matchRejectionFeedback).values({
      userId,
      productId,
      productName: product.name,
      canonicalItemId,
      canonicalItemName,
      note: trimmedNote.slice(0, 1000),
    })
  }

  await db
    .update(products)
    .set({
      matchStatus: 'rejected',
      canonicalItemId: null,
      matchScore: null,
      matchReason: null,
    })
    .where(eq(products.id, productId))

  // Rejecting one pack size rejects them all: every other product still awaiting
  // review that was matched to the same canonical item is also rejected and
  // unlinked. Already-confirmed products are left untouched, so a deliberate
  // confirmation on another pack size is never overturned by a rejection.
  let cascaded = 0
  if (canonicalItemId !== null) {
    const siblings = await db
      .update(products)
      .set({
        matchStatus: 'rejected',
        canonicalItemId: null,
        matchScore: null,
        matchReason: null,
      })
      .where(
        and(
          eq(products.canonicalItemId, canonicalItemId),
          eq(products.matchStatus, 'suggested'),
        ),
      )
      .returning({ id: products.id })
    cascaded = siblings.length
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  // `rejected` counts every product moved to rejected: the target plus any other
  // pending pack sizes of the same item.
  return { rejected: 1 + cascaded }
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

  // Manual confirmation cascades just like confirmMatch: other pack sizes of
  // the assigned canonical item that are still pending review get confirmed too.
  const siblings = await db
    .update(products)
    .set({ matchStatus: 'confirmed' })
    .where(
      and(
        eq(products.canonicalItemId, canonicalItemId),
        eq(products.matchStatus, 'suggested'),
      ),
    )
    .returning({ id: products.id })

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { confirmed: 1 + siblings.length }
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
