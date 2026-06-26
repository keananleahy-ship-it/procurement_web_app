'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  deleteFeedback,
  updateFeedback,
  type FeedbackItem,
} from '@/app/actions/feedback'
import {
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  OPEN_FEEDBACK_STATUSES,
  type FeedbackStatus,
} from '@/lib/feedback-shared'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/empty-state'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  CheckCircle2,
  Flag,
  GitCompareArrows,
  MessageSquare,
  Trash2,
} from 'lucide-react'

function statusBadgeClass(status: FeedbackStatus): string {
  switch (status) {
    case 'open':
      return 'bg-warning/15 text-warning border-warning/30'
    case 'reviewing':
      return 'bg-primary/15 text-primary border-primary/30'
    case 'resolved':
      return 'bg-success/15 text-success border-success/30'
    default:
      return 'bg-muted text-muted-foreground border-border'
  }
}

type FilterKey = 'attention' | FeedbackStatus | 'all'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'all', label: 'All' },
  ...FEEDBACK_STATUSES.map((s) => ({ key: s, label: FEEDBACK_STATUS_LABELS[s] })),
]

export function FeedbackManager({ items }: { items: FeedbackItem[] }) {
  const [filter, setFilter] = useState<FilterKey>('attention')
  const [isPending, startTransition] = useTransition()
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Local draft of admin notes keyed by feedback id.
  const [notes, setNotes] = useState<Record<number, string>>({})

  const counts = useMemo(() => {
    const c: Record<string, number> = { attention: 0, all: items.length }
    for (const s of FEEDBACK_STATUSES) c[s] = 0
    for (const it of items) {
      c[it.status] = (c[it.status] ?? 0) + 1
      if (OPEN_FEEDBACK_STATUSES.includes(it.status)) c.attention += 1
    }
    return c
  }, [items])

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'attention')
      return items.filter((it) => OPEN_FEEDBACK_STATUSES.includes(it.status))
    return items.filter((it) => it.status === filter)
  }, [items, filter])

  function run(id: number, fn: () => Promise<unknown>) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setPendingId(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const count = counts[f.key] ?? 0
          const active = filter === f.key
          return (
            <Button
              key={f.key}
              size="sm"
              variant={active ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span
                className={cn(
                  'ml-1.5 tabular-nums',
                  active ? 'opacity-80' : 'text-muted-foreground',
                )}
              >
                {count}
              </span>
            </Button>
          )
        })}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No feedback here"
          description={
            filter === 'attention'
              ? 'Nothing needs attention right now. Reports filed from the Compare tab will show up here.'
              : 'No feedback matches this filter.'
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((it) => {
            const rowBusy = isPending && pendingId === it.id
            const noteDraft = notes[it.id] ?? it.adminNote ?? ''
            const noteChanged = noteDraft.trim() !== (it.adminNote ?? '').trim()
            return (
              <div
                key={it.id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn('gap-1', statusBadgeClass(it.status))}
                      >
                        {it.status === 'resolved' ? (
                          <CheckCircle2 className="size-3" />
                        ) : (
                          <Flag className="size-3" />
                        )}
                        {FEEDBACK_STATUS_LABELS[it.status]}
                      </Badge>
                      <Badge variant="secondary">
                        {FEEDBACK_CATEGORY_LABELS[it.category] ?? it.category}
                      </Badge>
                      <span className="text-sm font-semibold text-foreground">
                        {it.subject ?? 'Comparison'}
                      </span>
                      {it.vendorName && (
                        <span className="text-xs text-muted-foreground">
                          · {it.vendorName}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      From {it.submitterName ?? 'Unknown'}
                      {it.submitterEmail ? ` (${it.submitterEmail})` : ''} ·{' '}
                      {formatDate(it.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {it.comparisonKey && (
                      <Link
                        href="/compare"
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          'h-8 gap-1.5',
                        )}
                      >
                        <GitCompareArrows className="size-3.5" />
                        Open Compare
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete feedback"
                      disabled={rowBusy}
                      onClick={() => {
                        if (confirm('Delete this feedback entry permanently?')) {
                          run(it.id, () => deleteFeedback(it.id))
                        }
                      }}
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>

                <p className="whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground">
                  {it.message}
                </p>

                {it.status === 'resolved' || it.status === 'dismissed' ? (
                  it.resolvedByName && (
                    <p className="text-xs text-muted-foreground">
                      {it.status === 'resolved' ? 'Resolved' : 'Dismissed'} by{' '}
                      {it.resolvedByName}
                      {it.resolvedAt ? ` · ${formatDate(it.resolvedAt)}` : ''}
                    </p>
                  )
                ) : null}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Textarea
                    value={noteDraft}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [it.id]: e.target.value }))
                    }
                    placeholder="Add an internal note (optional)…"
                    rows={2}
                    maxLength={2000}
                    className="text-sm"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Set status
                      </span>
                      <Select
                        value={it.status}
                        onValueChange={(value) => {
                          run(it.id, () =>
                            updateFeedback(
                              it.id,
                              value as FeedbackStatus,
                              notes[it.id] ?? it.adminNote ?? '',
                            ),
                          )
                        }}
                        disabled={rowBusy}
                      >
                        <SelectTrigger className="h-8 w-36" aria-label="Status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FEEDBACK_STATUSES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {FEEDBACK_STATUS_LABELS[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {noteChanged && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={rowBusy}
                        onClick={() =>
                          run(it.id, () =>
                            updateFeedback(it.id, it.status, noteDraft),
                          )
                        }
                      >
                        Save note
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
