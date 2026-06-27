'use client'

import { useMemo, useState, useTransition } from 'react'
import type { MatchRow } from '@/app/actions/canonical'
import {
  assignMatch,
  confirmMatch,
  generateAiSuggestions,
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

export function MatchingView({
  rows,
  canonicalItems,
}: {
  rows: MatchRow[]
  canonicalItems: CanonicalOption[]
}) {
  const [isPending, startTransition] = useTransition()
  const [genPending, startGen] = useTransition()
  const [aiPending, startAi] = useTransition()
  const canEdit = useCanEdit()

  // Reject-feedback dialog state. We capture a free-text note explaining why a
  // suggestion is wrong; that note is stored and fed back into the AI pass.
  const [rejectTarget, setRejectTarget] = useState<{
    productId: number
    productName: string
    canonicalItemName: string | null
  } | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [rejectPending, startReject] = useTransition()

  function submitReject() {
    if (!rejectTarget) return
    const { productId } = rejectTarget
    const note = rejectNote
    startReject(async () => {
      const res = await rejectMatch(productId, note)
      setRejectTarget(null)
      setRejectNote('')
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
              onClick={() =>
                startAi(() => {
                  void generateAiSuggestions()
                })
              }
            >
              <Sparkles className="size-4" />
              {aiPending ? 'Thinking…' : 'AI match pass'}
            </Button>
          </div>
        )}
      </div>

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

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rejectPending) {
            setRejectTarget(null)
            setRejectNote('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this match</DialogTitle>
            <DialogDescription>
              {rejectTarget?.canonicalItemName ? (
                <>
                  Tell us why{' '}
                  <span className="font-medium text-foreground">
                    {rejectTarget.productName}
                  </span>{' '}
                  is not{' '}
                  <span className="font-medium text-foreground">
                    {rejectTarget.canonicalItemName}
                  </span>
                  . This rejects every pack size of the item, and your note
                  trains future suggestions.
                </>
              ) : (
                <>
                  Tell us why this suggestion for{' '}
                  <span className="font-medium text-foreground">
                    {rejectTarget?.productName}
                  </span>{' '}
                  is wrong. This rejects every pack size of the item, and your
                  note trains future suggestions.
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
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="e.g. Different grade — this is food-grade, the canonical item is industrial."
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={rejectPending}
              onClick={() => {
                setRejectTarget(null)
                setRejectNote('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectPending}
              onClick={submitReject}
            >
              <X className="size-4" />
              Reject match
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
