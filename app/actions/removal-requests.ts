'use server'

import { db } from '@/lib/db'
import {
  canonicalItems,
  matchRejectionFeedback,
  matchRemovalRequests,
  products,
} from '@/lib/db/schema'
import { requireUser, requireAdmin } from '@/lib/roles'
import { and, desc, eq, ne } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

/**
 * Raised by ANY signed-in user from the compare page: request that a product be
 * removed from its current match. Stored as 'pending' for an admin to resolve.
 * Captures the reason up front so admins have context and so approval can feed
 * it into the rejection-feedback signal used by the AI matcher.
 */
export async function submitRemovalRequest(productId: number, reason: string) {
  const { id: userId, name } = await requireUser()

  const trimmed = (reason ?? '').trim()
  if (!trimmed) throw new Error('A reason is required to request removal.')

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
  if (!product) throw new Error('Product not found.')

  // Avoid stacking duplicate pending requests for the same product.
  const [existing] = await db
    .select({ id: matchRemovalRequests.id })
    .from(matchRemovalRequests)
    .where(
      and(
        eq(matchRemovalRequests.productId, productId),
        eq(matchRemovalRequests.status, 'pending'),
      ),
    )
    .limit(1)
  if (existing) {
    throw new Error('A removal request for this item is already pending.')
  }

  let canonicalItemName: string | null = null
  if (product.canonicalItemId !== null) {
    const [ci] = await db
      .select({ name: canonicalItems.name })
      .from(canonicalItems)
      .where(eq(canonicalItems.id, product.canonicalItemId))
      .limit(1)
    canonicalItemName = ci?.name ?? null
  }

  await db.insert(matchRemovalRequests).values({
    requestedByUserId: userId,
    requestedByName: name ?? null,
    productId,
    productName: product.name,
    canonicalItemId: product.canonicalItemId,
    canonicalItemName,
    reason: trimmed.slice(0, 1000),
  })

  revalidatePath('/compare')
  revalidatePath('/')
}

/** All pending removal requests, newest first (admin queue). */
export async function getPendingRemovalRequests() {
  await requireUser()
  return db
    .select()
    .from(matchRemovalRequests)
    .where(eq(matchRemovalRequests.status, 'pending'))
    .orderBy(desc(matchRemovalRequests.createdAt))
}

/** Count of pending requests, for the overview alert badge. */
export async function getPendingRemovalRequestCount() {
  await requireUser()
  const rows = await db
    .select({ id: matchRemovalRequests.id })
    .from(matchRemovalRequests)
    .where(eq(matchRemovalRequests.status, 'pending'))
  return rows.length
}

/**
 * Admin approves a removal request: unlink the product from its canonical item
 * and mark it 'rejected', cascading to ALL other pack sizes of the same item
 * (these are confirmed matches on the compare page, so we intentionally include
 * confirmed siblings, not just suggested ones). The requester's reason is also
 * recorded as rejection feedback so the AI matcher learns from it.
 */
export async function approveRemovalRequest(requestId: number) {
  const { id: adminId, name: adminName } = await requireAdmin()

  const [reqRow] = await db
    .select()
    .from(matchRemovalRequests)
    .where(eq(matchRemovalRequests.id, requestId))
    .limit(1)
  if (!reqRow) throw new Error('Request not found.')
  if (reqRow.status !== 'pending') {
    throw new Error('This request has already been resolved.')
  }

  const canonicalItemId = reqRow.canonicalItemId

  // Record feedback tying the rejected product to the canonical item and reason.
  await db.insert(matchRejectionFeedback).values({
    userId: reqRow.requestedByUserId,
    productId: reqRow.productId,
    productName: reqRow.productName,
    canonicalItemId,
    canonicalItemName: reqRow.canonicalItemName,
    note: reqRow.reason.slice(0, 1000),
  })

  // Reject + unlink the requested product.
  await db
    .update(products)
    .set({
      matchStatus: 'rejected',
      canonicalItemId: null,
      matchScore: null,
      matchReason: null,
    })
    .where(eq(products.id, reqRow.productId))

  // Cascade to every OTHER pack size still linked to the same canonical item,
  // regardless of confirmed/suggested status, so the whole item leaves the
  // comparison together.
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
          ne(products.id, reqRow.productId),
        ),
      )
      .returning({ id: products.id })
    cascaded = siblings.length
  }

  await db
    .update(matchRemovalRequests)
    .set({
      status: 'approved',
      resolvedByUserId: adminId,
      resolvedByName: adminName ?? null,
      resolvedAt: new Date(),
    })
    .where(eq(matchRemovalRequests.id, requestId))

  revalidatePath('/matching')
  revalidatePath('/compare')
  revalidatePath('/')
  return { rejected: 1 + cascaded }
}

/** Admin denies a removal request: the match is left intact. */
export async function denyRemovalRequest(requestId: number) {
  const { id: adminId, name: adminName } = await requireAdmin()

  const [reqRow] = await db
    .select({ status: matchRemovalRequests.status })
    .from(matchRemovalRequests)
    .where(eq(matchRemovalRequests.id, requestId))
    .limit(1)
  if (!reqRow) throw new Error('Request not found.')
  if (reqRow.status !== 'pending') {
    throw new Error('This request has already been resolved.')
  }

  await db
    .update(matchRemovalRequests)
    .set({
      status: 'denied',
      resolvedByUserId: adminId,
      resolvedByName: adminName ?? null,
      resolvedAt: new Date(),
    })
    .where(eq(matchRemovalRequests.id, requestId))

  revalidatePath('/')
}
