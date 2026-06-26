'use server'

import { db } from '@/lib/db'
import { matchFeedback } from '@/lib/db/schema'
import { requireUser, requireAdmin } from '@/lib/roles'
import {
  type FeedbackCategory,
  type FeedbackStatus,
  OPEN_FEEDBACK_STATUSES,
  isFeedbackCategory,
  isFeedbackStatus,
} from '@/lib/feedback-shared'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export type FeedbackItem = {
  id: number
  userId: string
  submitterName: string | null
  submitterEmail: string | null
  comparisonKey: string | null
  subject: string | null
  productId: number | null
  priceId: number | null
  vendorName: string | null
  canonicalItemId: number | null
  category: FeedbackCategory
  message: string
  status: FeedbackStatus
  adminNote: string | null
  resolvedByName: string | null
  resolvedAt: string | null
  createdAt: string | null
}

export type SubmitFeedbackInput = {
  category: string
  message: string
  comparisonKey?: string | null
  subject?: string | null
  productId?: number | null
  priceId?: number | null
  vendorName?: string | null
  canonicalItemId?: number | null
}

// Any signed-in user (including viewers) can report an issue from the Compare
// tab. The submitter's identity is captured for admin follow-up.
export async function submitFeedback(input: SubmitFeedbackInput) {
  const me = await requireUser()

  if (!isFeedbackCategory(input.category)) {
    throw new Error('Invalid feedback category.')
  }
  const message = input.message?.trim()
  if (!message) throw new Error('Please describe the issue.')

  await db.insert(matchFeedback).values({
    userId: me.id,
    submitterName: me.name,
    submitterEmail: me.email,
    comparisonKey: input.comparisonKey ?? null,
    subject: input.subject?.slice(0, 200) ?? null,
    productId: input.productId ?? null,
    priceId: input.priceId ?? null,
    vendorName: input.vendorName ?? null,
    canonicalItemId: input.canonicalItemId ?? null,
    category: input.category,
    message: message.slice(0, 2000),
  })

  revalidatePath('/admin/feedback')
}

function toIso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null
}

// Admin-only: full feedback list, newest first, with open items prioritized.
export async function getFeedback(): Promise<FeedbackItem[]> {
  await requireAdmin()
  const rows = await db
    .select()
    .from(matchFeedback)
    .orderBy(desc(matchFeedback.createdAt))

  // Surface still-actionable items first, then by recency.
  const weight = (s: string) => (OPEN_FEEDBACK_STATUSES.includes(s as FeedbackStatus) ? 0 : 1)
  return rows
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      submitterName: r.submitterName,
      submitterEmail: r.submitterEmail,
      comparisonKey: r.comparisonKey,
      subject: r.subject,
      productId: r.productId,
      priceId: r.priceId,
      vendorName: r.vendorName,
      canonicalItemId: r.canonicalItemId,
      category: r.category as FeedbackCategory,
      message: r.message,
      status: r.status as FeedbackStatus,
      adminNote: r.adminNote,
      resolvedByName: r.resolvedByName,
      resolvedAt: toIso(r.resolvedAt),
      createdAt: toIso(r.createdAt),
    }))
    .sort((a, b) => {
      const w = weight(a.status) - weight(b.status)
      if (w !== 0) return w
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    })
}

// Admin-only: count of feedback still needing attention, for the nav badge.
export async function getOpenFeedbackCount(): Promise<number> {
  await requireAdmin()
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matchFeedback)
    .where(inArray(matchFeedback.status, OPEN_FEEDBACK_STATUSES))
  return row?.count ?? 0
}

// Admin-only: update triage state and optional note. Stamps resolver identity
// when moving to a terminal status; clears it when reopened.
export async function updateFeedback(
  id: number,
  status: string,
  adminNote?: string | null,
) {
  const admin = await requireAdmin()
  if (!isFeedbackStatus(status)) throw new Error('Invalid status.')

  const terminal = status === 'resolved' || status === 'dismissed'
  await db
    .update(matchFeedback)
    .set({
      status,
      adminNote: adminNote?.trim() ? adminNote.trim().slice(0, 2000) : null,
      resolvedBy: terminal ? admin.id : null,
      resolvedByName: terminal ? admin.name : null,
      resolvedAt: terminal ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(matchFeedback.id, id))
  revalidatePath('/admin/feedback')
}

// Admin-only: permanently remove a feedback entry.
export async function deleteFeedback(id: number) {
  await requireAdmin()
  await db.delete(matchFeedback).where(eq(matchFeedback.id, id))
  revalidatePath('/admin/feedback')
}
