'use server'

import { db } from '@/lib/db'
import { matchFeedback, user } from '@/lib/db/schema'
import { requireUser, requireAdmin } from '@/lib/roles'
import {
  type FeedbackCategory,
  type FeedbackStatus,
  FEEDBACK_CATEGORY_LABELS,
  OPEN_FEEDBACK_STATUSES,
  isFeedbackCategory,
  isFeedbackStatus,
} from '@/lib/feedback-shared'
import { sendEmail } from '@/lib/email'
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

  const trimmedMessage = message.slice(0, 2000)
  const subject = input.subject?.slice(0, 200) ?? null

  const [created] = await db
    .insert(matchFeedback)
    .values({
      userId: me.id,
      submitterName: me.name,
      submitterEmail: me.email,
      comparisonKey: input.comparisonKey ?? null,
      subject,
      productId: input.productId ?? null,
      priceId: input.priceId ?? null,
      vendorName: input.vendorName ?? null,
      canonicalItemId: input.canonicalItemId ?? null,
      category: input.category,
      message: trimmedMessage,
    })
    .returning({ id: matchFeedback.id })

  // Notify admins. Best-effort and non-blocking — a mail failure must never
  // prevent the report from being recorded.
  await notifyAdminsOfNewReport({
    id: created?.id,
    category: input.category,
    message: trimmedMessage,
    subject,
    vendorName: input.vendorName ?? null,
    submitterName: me.name,
    submitterEmail: me.email,
  }).catch((err) => {
    console.log('[v0] notifyAdminsOfNewReport failed:', err?.message ?? err)
  })

  revalidatePath('/admin/feedback')
}

// Emails every admin user about a freshly submitted report. Recipients are
// looked up live from the database so role changes take effect immediately.
async function notifyAdminsOfNewReport(report: {
  id?: number
  category: FeedbackCategory
  message: string
  subject: string | null
  vendorName: string | null
  submitterName: string | null
  submitterEmail: string | null
}) {
  const admins = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.role, 'admin'))

  const recipients = admins.map((a) => a.email).filter(Boolean)
  if (recipients.length === 0) return

  const categoryLabel = FEEDBACK_CATEGORY_LABELS[report.category] ?? report.category
  const submitter =
    report.submitterName || report.submitterEmail || 'A user'
  const aboutLine = report.subject
    ? `${report.subject}${report.vendorName ? ` — ${report.vendorName}` : ''}`
    : report.vendorName || 'a product comparison'

  const reviewUrl = appUrl('/admin/feedback')

  const text = [
    `${submitter} reported an issue in the Compare tab.`,
    '',
    `Type: ${categoryLabel}`,
    `About: ${aboutLine}`,
    report.submitterEmail ? `From: ${submitter} <${report.submitterEmail}>` : `From: ${submitter}`,
    '',
    'Details:',
    report.message,
    '',
    `Review it here: ${reviewUrl}`,
  ].join('\n')

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.5;">
      <h2 style="margin:0 0 12px;font-size:18px;">New Compare feedback</h2>
      <p style="margin:0 0 16px;color:#475569;">
        ${escapeHtml(submitter)} reported an issue in the Compare tab.
      </p>
      <table style="border-collapse:collapse;margin-bottom:16px;">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Type</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(categoryLabel)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b;">About</td><td style="padding:4px 0;">${escapeHtml(aboutLine)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b;">From</td><td style="padding:4px 0;">${escapeHtml(submitter)}${report.submitterEmail ? ` &lt;${escapeHtml(report.submitterEmail)}&gt;` : ''}</td></tr>
      </table>
      <div style="padding:12px 16px;background:#f1f5f9;border-radius:8px;margin-bottom:20px;white-space:pre-wrap;">${escapeHtml(report.message)}</div>
      <a href="${reviewUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Review in admin</a>
    </div>
  `.trim()

  await sendEmail({
    to: recipients,
    subject: `New Compare feedback: ${categoryLabel}`,
    text,
    html,
    replyTo: report.submitterEmail ?? undefined,
  })
}

// Absolute URL for links inside emails. Prefers an explicit app URL, then the
// Vercel deployment URL, falling back to a relative path.
function appUrl(path: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : '')
  return base ? `${base.replace(/\/$/, '')}${path}` : path
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
