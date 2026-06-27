'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { MatchRow } from '@/app/actions/canonical'
import {
  assignMatch,
  confirmMatch,
  generateSuggestions,
  rejectMatch,
  rematchRejected,
  resetMatch,
} from '@/app/actions/canonical'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'
import { cn } from '@/lib/utils'
import {
  Check,
  X,
  RotateCcw,
  RefreshCw,
  Sparkles,
  ListChecks,
  AlertCircle,
} from 'lucide-react'

type CanonicalOption = { id: number; name: string }

function ConfidenceBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>
  const pct = Math.round(score * 100)
  const tone =
    score >= 0.7
      ? 'bg-success/10 text-success'
      : score >= 0.5
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'bg-muted text-muted-foreground'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums',
        tone,
      )}
    >
      {pct}% match
    </span>
  )
}

function AssignSelect({
  productId,
  canonicalItems,
  placeholder = 'Assign manually',
  disabled,
  onAssign,
}: {
  productId: number
  canonicalItems: CanonicalOption[]
  placeholder?: string
  disabled?: boolean
  onAssign: (productId: number, canonicalItemId: number) => void
}) {
  return (
    // value is intentionally uncontrolled: the dropdown is an action trigger
    // for (re)assignment, and the current canonical item is shown elsewhere in
    // the row. This avoids Radix rendering the raw id before the menu opens.
    <Select
      disabled={disabled}
      value=""
      onValueChange={(v) => onAssign(productId, Number(v))}
    >
      <SelectTrigger className="h-8 w-44 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {canonicalItems.map((c) => (
          <SelectItem key={c.id} value={String(c.id)} className="text-xs">
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type RejectTarget = {
  productId: number
  productName: string
  canonicalItemName: string | null
}

// Isolated in its own component so its note state lives here, not in
// MatchingView. Typing in the textarea re-renders only this dialog instead of
// the parent's large product tables (which previously caused per-keystroke lag).
function RejectDialog({
  target,
  pending,
  onCancel,
  onSubmit,
}: {
  target: RejectTarget | null
  pending: boolean
  onCancel: () => void
  onSubmit: (note: string) => void
}) {
  const [note, setNote] = useState('')

  // Reset the note whenever a new target is opened.
  useEffect(() => {
    if (target) setNote('')
  }, [target])

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this match</DialogTitle>
          <DialogDescription>
            {target?.canonicalItemName ? (
              <>
                Tell us why{' '}
                <span className="font-medium text-foreground">
                  {target.productName}
                </span>{' '}
                is not{' '}
                <span className="font-medium text-foreground">
                  {target.canonicalItemName}
                </span>
                . This rejects every pack size of the item, and your note trains
                future suggestions.
              </>
            ) : (
              <>
                Tell us why this suggestion for{' '}
                <span className="font-medium text-foreground">
                  {target?.productName}
                </span>{' '}
                is wrong. This rejects every pack size of the item, and your note
                trains future suggestions.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reject-note">
            Why is this match wrong?{' '}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Different grade — this is food-grade, the canonical item is industrial."
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => onSubmit(note)}
          >
            <X className="size-4" />
            Reject match
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type AiProgress = {
  batchesDone: number
  totalBatches: number
  productsDone: number
  totalProducts: number
  suggested: number
  cleared: number
  skipped: number
  phase: 'running' | 'done' | 'error'
}

// Determinate progress bar for the streaming AI match pass. Driven entirely by
// the per-batch events streamed from /api/matching/ai-pass.
function AiPassProgress({ progress }: { progress: AiProgress }) {
  const { phase, totalProducts, productsDone, suggested, cleared, skipped } =
    progress
  const pct =
    phase === 'done'
      ? 100
      : totalProducts > 0
        ? Math.round((productsDone / totalProducts) * 100)
        : 5

  const heading =
    phase === 'done'
      ? 'AI match pass complete'
      : phase === 'error'
        ? 'AI match pass failed'
        : 'Running AI match pass…'

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles
            className={cn(
              'size-4 text-accent-foreground',
              phase === 'running' && 'animate-pulse',
            )}
          />
          {heading}
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {phase === 'running' && totalProducts > 0
            ? `${productsDone} / ${totalProducts} products`
            : `${pct}%`}
        </span>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out',
            phase === 'error' ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        {suggested} matched
        {cleared > 0 ? ` · ${cleared} unmatched` : ''}
        {skipped > 0 ? ` · ${skipped} skipped` : ''}
        {phase === 'done' ? ' — review them under “Needs review”.' : ''}
      </p>
    </div>
  )
}

export function MatchingView({
  rows,
  canonicalItems,
}: {
  rows: MatchRow[]
  canonicalItems: CanonicalOption[]
}) {
  const [isPending, startTransition] = useTransition()
  const [genPending, startGen] = useTransition()
  const canEdit = useCanEdit()
  const router = useRouter()

  // Live progress for the streaming AI match pass. While running, `aiProgress`
  // holds batch/product counts streamed from the server so we can show a real
  // determinate progress bar instead of an indeterminate spinner.
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null)
  const aiPending = aiProgress?.phase === 'running'

  async function runAiPass() {
    if (aiPending) return
    setCascadeMsg(null)
    setAiProgress({
      batchesDone: 0,
      totalBatches: 0,
      productsDone: 0,
      totalProducts: 0,
      suggested: 0,
      cleared: 0,
      skipped: 0,
      phase: 'running',
    })
    try {
      const res = await fetch('/api/matching/ai-pass', { method: 'POST' })
      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`)
      }

      // Parse the newline-delimited JSON progress stream.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let last: Partial<AiProgress> = {}

      const handle = (evt: Record<string, unknown>) => {
        if (evt.type === 'start') {
          last = {
            batchesDone: 0,
            totalBatches: Number(evt.totalBatches) || 0,
            productsDone: 0,
            totalProducts: Number(evt.totalProducts) || 0,
            suggested: 0,
            cleared: 0,
            skipped: 0,
          }
          setAiProgress({ ...(last as AiProgress), phase: 'running' })
        } else if (evt.type === 'progress') {
          last = {
            batchesDone: Number(evt.batchesDone) || 0,
            totalBatches: Number(evt.totalBatches) || 0,
            productsDone: Number(evt.productsDone) || 0,
            totalProducts: Number(evt.totalProducts) || 0,
            suggested: Number(evt.suggested) || 0,
            cleared: Number(evt.cleared) || 0,
            skipped: Number(evt.skipped) || 0,
          }
          setAiProgress({ ...(last as AiProgress), phase: 'running' })
        } else if (evt.type === 'done') {
          const suggested = Number(evt.suggested) || 0
          const skipped = Number(evt.skipped) || 0
          setAiProgress({
            ...(last as AiProgress),
            suggested,
            cleared: Number(evt.cleared) || (last.cleared ?? 0),
            skipped,
            phase: 'done',
          })
          if (skipped > 0) {
            setCascadeMsg(
              `Suggested ${suggested}, but ${skipped} products couldn't be processed (likely an AI rate limit). Existing matches were left untouched — run the AI pass again to finish them.`,
            )
          }
        }
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            handle(JSON.parse(trimmed))
          } catch {
            /* ignore partial/non-JSON lines */
          }
        }
      }

      // Pull in the new suggestions, then clear the bar shortly after.
      router.refresh()
      setTimeout(() => setAiProgress(null), 2500)
    } catch (err) {
      console.log('[v0] AI pass failed:', err)
      setAiProgress((prev) =>
        prev
          ? { ...prev, phase: 'error' }
          : {
              batchesDone: 0,
              totalBatches: 0,
              productsDone: 0,
              totalProducts: 0,
              suggested: 0,
              cleared: 0,
              skipped: 0,
              phase: 'error',
            },
      )
      setCascadeMsg(
        'The AI match pass failed to run. Please try again in a moment.',
      )
    }
  }

  // Reject-feedback dialog state. The note itself is owned by RejectDialog so
  // typing doesn't re-render this component's large tables; we only track which
  // product is being rejected.
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null)
  const [rejectPending, startReject] = useTransition()

  function submitReject(note: string) {
    if (!rejectTarget) return
    const { productId } = rejectTarget
    startReject(async () => {
      const res = await rejectMatch(productId, note)
      setRejectTarget(null)
      setCascadeMsg(
        res.rejected > 1
          ? `Rejected all ${res.rejected} pack sizes of this item.`
          : null,
      )
    })
  }

  const groups = useMemo(() => {
    return {
      suggested: rows.filter((r) => r.matchStatus === 'suggested'),
      confirmed: rows.filter((r) => r.matchStatus === 'confirmed'),
      other: rows.filter(
        (r) => r.matchStatus === 'unmatched' || r.matchStatus === 'rejected',
      ),
    }
  }, [rows])

  const noCanonical = canonicalItems.length === 0

  // Transient banner announcing how many pack sizes a single confirm/assign
  // cascaded to, since confirming one product confirms every pack size of the
  // same canonical item.
  const [cascadeMsg, setCascadeMsg] = useState<string | null>(null)

  function run(fn: () => Promise<unknown>) {
    startTransition(() => {
      void fn()
    })
  }

  function confirm(productId: number) {
    startTransition(async () => {
      const res = await confirmMatch(productId)
      setCascadeMsg(
        res.confirmed > 1
          ? `Confirmed all ${res.confirmed} pack sizes of this item.`
          : null,
      )
    })
  }

  function assign(productId: number, canonicalItemId: number) {
    startTransition(async () => {
      const res = await assignMatch(productId, canonicalItemId)
      setCascadeMsg(
        res.confirmed > 1
          ? `Assigned and confirmed all ${res.confirmed} pack sizes of this item.`
          : null,
      )
    })
  }

  // Re-match rejected products using the notes left at rejection time. Any that
  // get a new, confident suggestion move back into "Needs review".
  const [rematchPending, startRematch] = useTransition()
  const [rematchMsg, setRematchMsg] = useState<string | null>(null)

  const rejectedCount = useMemo(
    () => groups.other.filter((r) => r.matchStatus === 'rejected').length,
    [groups.other],
  )

  function runRematch() {
    setRematchMsg(null)
    startRematch(async () => {
      const res = await rematchRejected()
      setRematchMsg(
        res.resuggested > 0
          ? `Re-matched ${res.resuggested} rejected ${
              res.resuggested === 1 ? 'item' : 'items'
            } — review ${
              res.resuggested === 1 ? 'it' : 'them'
            } under “Needs review”.`
          : 'No better matches found for the rejected items yet.',
      )
    })
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Sparkles className="size-4" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              Auto-match products to canonical items
            </p>
            <p className="text-sm text-muted-foreground">
              Run a fast name-similarity pass, then an AI pass that catches
              synonyms and pack-size variants. You confirm or reject each one —
              nothing is grouped until you approve it. Confirming a match
              applies to every pack size of that item.
            </p>
          </div>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={genPending || aiPending || noCanonical}
              onClick={() =>
                startGen(() => {
                  void generateSuggestions()
                })
              }
            >
              <ListChecks className="size-4" />
              {genPending ? 'Scanning…' : 'Name match'}
            </Button>
            <Button
              disabled={aiPending || genPending || noCanonical}
              onClick={runAiPass}
            >
              <Sparkles className={cn('size-4', aiPending && 'animate-pulse')} />
              {aiPending ? 'Matching…' : 'AI match pass'}
            </Button>
          </div>
        )}
      </div>

      {aiProgress && (
        <AiPassProgress progress={aiProgress} />
      )}

      {noCanonical && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="size-4 shrink-0" />
          Add canonical items first, then generate suggestions to match your
          products against them.
        </div>
      )}

      {cascadeMsg && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          <Check className="size-4 shrink-0" />
          {cascadeMsg}
        </div>
      )}

      <Tabs defaultValue="suggested" onValueChange={() => setCascadeMsg(null)}>
        <TabsList>
          <TabsTrigger value="suggested">
            Needs review
            {groups.suggested.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {groups.suggested.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="confirmed">
            Confirmed
            {groups.confirmed.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {groups.confirmed.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="other">
            Unmatched
            {groups.other.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {groups.other.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Needs review */}
        <TabsContent value="suggested" className="mt-4">
          {groups.suggested.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No suggestions to review"
              description="Generate suggestions to surface fuzzy matches that need your verification."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor product</TableHead>
                    <TableHead>Suggested canonical item</TableHead>
                    <TableHead>Confidence</TableHead>
                    {canEdit && <TableHead className="text-right">Verify</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.suggested.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-medium text-foreground">
                        {r.productName}
                        {r.category && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {r.category}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-foreground">
                        <div className="flex flex-col gap-0.5">
                          <span>{r.canonicalItemName ?? '—'}</span>
                          {r.matchReason && (
                            <span className="max-w-xs text-xs text-muted-foreground">
                              {r.matchReason}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <ConfidenceBadge score={r.matchScore} />
                          {r.matchMethod === 'ai' && (
                            <Badge
                              variant="outline"
                              className="gap-1 border-accent-foreground/20 text-xs text-accent-foreground"
                            >
                              <Sparkles className="size-3" />
                              AI
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            <AssignSelect
                              productId={r.productId}
                              canonicalItems={canonicalItems}
                              placeholder="Reassign…"
                              disabled={isPending}
                              onAssign={(id, cid) => assign(id, cid)}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isPending}
                              onClick={() =>
                                setRejectTarget({
                                  productId: r.productId,
                                  productName: r.productName,
                                  canonicalItemName: r.canonicalItemName ?? null,
                                })
                              }
                            >
                              <X className="size-4" />
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              disabled={isPending}
                              title="Confirms this and every other pack size of the same item"
                              onClick={() => confirm(r.productId)}
                            >
                              <Check className="size-4" />
                              Confirm
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Confirmed */}
        <TabsContent value="confirmed" className="mt-4">
          {groups.confirmed.length === 0 ? (
            <EmptyState
              icon={Check}
              title="No confirmed matches"
              description="Confirmed matches group vendor products under one canonical item in the Compare view."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor product</TableHead>
                    <TableHead>Canonical item</TableHead>
                    {canEdit && <TableHead className="text-right">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.confirmed.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-medium text-foreground">
                        {r.productName}
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-success text-success-foreground hover:bg-success">
                          {r.canonicalItemName ?? 'Unknown'}
                        </Badge>
                      </TableCell>
                      {canEdit && (
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => run(() => resetMatch(r.productId))}
                          >
                            <RotateCcw className="size-4" />
                            Unlink
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Unmatched / rejected */}
        <TabsContent value="other" className="mt-4 flex flex-col gap-3">
          {canEdit && rejectedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {rejectedCount} rejected{' '}
                {rejectedCount === 1 ? 'item' : 'items'}. Re-match uses the notes
                you left to suggest a different canonical item.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={rematchPending}
                onClick={runRematch}
              >
                <RefreshCw
                  className={cn('size-4', rematchPending && 'animate-spin')}
                />
                {rematchPending ? 'Re-matching…' : 'Re-match with feedback'}
              </Button>
            </div>
          )}

          {rematchMsg && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm text-foreground"
            >
              <Sparkles className="size-4 shrink-0 text-accent-foreground" />
              {rematchMsg}
            </div>
          )}

          {groups.other.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="Everything is matched"
              description="No unmatched or rejected products right now."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor product</TableHead>
                    <TableHead>Status</TableHead>
                    {canEdit && <TableHead className="text-right">Assign</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.other.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-medium text-foreground">
                        {r.productName}
                        {r.category && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {r.category}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          {r.matchStatus === 'rejected' ? (
                            <Badge
                              variant="outline"
                              className="w-fit text-destructive"
                            >
                              Rejected
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="w-fit">
                              Unmatched
                            </Badge>
                          )}
                          {r.matchReason && (
                            <span className="max-w-xs text-xs text-muted-foreground">
                              {r.matchReason}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex justify-end">
                            <AssignSelect
                              productId={r.productId}
                              canonicalItems={canonicalItems}
                              disabled={isPending || noCanonical}
                              onAssign={(id, cid) => assign(id, cid)}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <RejectDialog
        target={rejectTarget}
        pending={rejectPending}
        onCancel={() => setRejectTarget(null)}
        onSubmit={submitReject}
      />
    </div>
  )
}
