'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { canonicalItems, products } from '@/lib/db/schema'
import { bestMatch } from '@/lib/match'
import { aiMatchProducts } from '@/lib/match-ai'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getCanonicalItems() {
  const userId = await getUserId()
  return db
    .select()
    .from(canonicalItems)
    .where(eq(canonicalItems.userId, userId))
    .orderBy(asc(canonicalItems.name))
}

export async function createCanonicalItem(formData: FormData) {
  const userId = await getUserId()
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
  const userId = await getUserId()
  // Detach any products pointing at this canonical item.
  await db
    .update(products)
    .set({ canonicalItemId: null, matchStatus: 'unmatched', matchScore: null })
    .where(
      and(eq(products.canonicalItemId, id), eq(products.userId, userId)),
    )
  await db
    .delete(canonicalItems)
    .where(and(eq(canonicalItems.id, id), eq(canonicalItems.userId, userId)))
  revalidatePath('/canonical')
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/**
 * Recompute fuzzy-match suggestions for every product that has not yet been
 * confirmed or rejected by the user. Confirmed/rejected products are left
 * untouched so human decisions are never overwritten.
 */
export async function generateSuggestions() {
  const userId = await getUserId()
  const [items, prods] = await Promise.all([
    db
      .select()
      .from(canonicalItems)
      .where(eq(canonicalItems.userId, userId)),
    db.select().from(products).where(eq(products.userId, userId)),
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
        .where(and(eq(products.id, p.id), eq(products.userId, userId)))
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
        .where(and(eq(products.id, p.id), eq(products.userId, userId)))
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
  const userId = await getUserId()
  const [items, prods] = await Promise.all([
    db.select().from(canonicalItems).where(eq(canonicalItems.userId, userId)),
    db.select().from(products).where(eq(products.userId, userId)),
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
  )

  const validCanonicalIds = new Set(canonicalOptions.map((c) => c.id))
  const byId = new Map(matches.map((m) => [m.productId, m]))

  let suggested = 0
  let cleared = 0
  for (const p of pending) {
    const m = byId.get(p.id)
    const hasMatch =
      m &&
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
        .where(and(eq(products.id, p.id), eq(products.userId, userId)))
      suggested++
    } else {
      await db
        .update(products)
        .set({
          canonicalItemId: null,
          matchStatus: 'unmatched',
          matchScore: null,
          matchMethod: 'ai',
          matchReason: m?.reason?.slice(0, 280) ?? null,
        })
        .where(and(eq(products.id, p.id), eq(products.userId, userId)))
      cleared++
    }
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { suggested, cleared }
}

export async function confirmMatch(productId: number) {
  const userId = await getUserId()
  await db
    .update(products)
    .set({ matchStatus: 'confirmed' })
    .where(
      and(
        eq(products.id, productId),
        eq(products.userId, userId),
        // Only confirm when there is something to confirm.
        inArray(products.matchStatus, ['suggested', 'rejected']),
      ),
    )
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

export async function rejectMatch(productId: number) {
  const userId = await getUserId()
  await db
    .update(products)
    .set({
      matchStatus: 'rejected',
      canonicalItemId: null,
      matchScore: null,
      matchReason: null,
    })
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/** Manually assign (or reassign) a product to a canonical item and confirm it. */
export async function assignMatch(productId: number, canonicalItemId: number) {
  const userId = await getUserId()
  await db
    .update(products)
    .set({
      canonicalItemId,
      matchStatus: 'confirmed',
      matchScore: null,
      matchMethod: 'manual',
      matchReason: null,
    })
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
}

/** Clear a match entirely, returning the product to the unmatched pool. */
export async function resetMatch(productId: number) {
  const userId = await getUserId()
  await db
    .update(products)
    .set({
      canonicalItemId: null,
      matchStatus: 'unmatched',
      matchScore: null,
      matchMethod: null,
      matchReason: null,
    })
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
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
  const userId = await getUserId()
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
    .where(eq(products.userId, userId))
    .orderBy(asc(products.name))

  return rows.map((r) => ({
    ...r,
    packSize: Number(r.packSize ?? 1),
    matchScore: r.matchScore === null ? null : Number(r.matchScore),
  }))
}
