// Shared, framework-agnostic constants/types for the Compare feedback feature.
// Importable from both client components and server actions (no 'server-only').

export const FEEDBACK_CATEGORIES = [
  { code: 'incorrect_match', label: 'Incorrect match / grouping' },
  { code: 'incorrect_container', label: 'Wrong container / pack size' },
  { code: 'wrong_price', label: 'Wrong price' },
  { code: 'wrong_unit', label: 'Wrong unit of measure' },
  { code: 'other', label: 'Something else' },
] as const

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]['code']

export const FEEDBACK_CATEGORY_LABELS = Object.fromEntries(
  FEEDBACK_CATEGORIES.map((c) => [c.code, c.label]),
) as Record<FeedbackCategory, string>

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return FEEDBACK_CATEGORIES.some((c) => c.code === value)
}

export const FEEDBACK_STATUSES = [
  'open',
  'reviewing',
  'resolved',
  'dismissed',
] as const

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: 'Open',
  reviewing: 'Reviewing',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(value)
}

// Statuses that still need admin attention (drives the sidebar badge count).
export const OPEN_FEEDBACK_STATUSES: FeedbackStatus[] = ['open', 'reviewing']
