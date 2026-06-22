'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { canonicalItems, products } from '@/lib/db/schema'
import { bestMatch } from '@/lib/match'
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

  await db.insert(canonicalItems).values({ userId, name, category, unit })
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

  console.log(
    '[v0] generateSuggestions',
    'products=',
    prods.length,
    'canonical=',
    candidates.length,
  )

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
        })
        .where(and(eq(products.id, p.id), eq(products.userId, userId)))
    }
  }

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { suggested }
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
    .set({ matchStatus: 'rejected', canonicalItemId: null, matchScore: null })
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
    .set({ canonicalItemId, matchStatus: 'confirmed', matchScore: null })
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
    .set({ canonicalItemId: null, matchStatus: 'unmatched', matchScore: null })
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
  matchStatus: string
  matchScore: number | null
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
      matchStatus: products.matchStatus,
      matchScore: products.matchScore,
      canonicalItemId: products.canonicalItemId,
      canonicalItemName: canonicalItems.name,
    })
    .from(products)
    .leftJoin(canonicalItems, eq(canonicalItems.id, products.canonicalItemId))
    .where(eq(products.userId, userId))
    .orderBy(asc(products.name))

  return rows.map((r) => ({
    ...r,
    matchScore: r.matchScore === null ? null : Number(r.matchScore),
  }))
}
