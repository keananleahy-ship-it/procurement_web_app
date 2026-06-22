'use client'

import { useMemo, useState, useTransition } from 'react'
import type { MatchRow } from '@/app/actions/canonical'
import {
  assignMatch,
  confirmMatch,
  generateSuggestions,
  rejectMatch,
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
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import {
  Check,
  X,
  RotateCcw,
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

  function run(fn: () => Promise<unknown>) {
    startTransition(() => {
      void fn()
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
              Suggestions are scored by name similarity. You confirm or reject
              each one — nothing is grouped until you approve it.
            </p>
          </div>
        </div>
        <Button
          disabled={genPending || noCanonical}
          onClick={() =>
            startGen(() => {
              void generateSuggestions()
            })
          }
        >
          <Sparkles className="size-4" />
          {genPending ? 'Scanning…' : 'Generate suggestions'}
        </Button>
      </div>

      {noCanonical && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <AlertCircle className="size-4 shrink-0" />
          Add canonical items first, then generate suggestions to match your
          products against them.
        </div>
      )}

      <Tabs defaultValue="suggested">
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
                    <TableHead className="text-right">Verify</TableHead>
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
                        {r.canonicalItemName ?? '—'}
                      </TableCell>
                      <TableCell>
                        <ConfidenceBadge score={r.matchScore} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <AssignSelect
                            productId={r.productId}
                            canonicalItems={canonicalItems}
                            placeholder="Reassign…"
                            disabled={isPending}
                            onAssign={(id, cid) => run(() => assignMatch(id, cid))}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={() => run(() => rejectMatch(r.productId))}
                          >
                            <X className="size-4" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            disabled={isPending}
                            onClick={() => run(() => confirmMatch(r.productId))}
                          >
                            <Check className="size-4" />
                            Confirm
                          </Button>
                        </div>
                      </TableCell>
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
                    <TableHead className="text-right">Action</TableHead>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* Unmatched / rejected */}
        <TabsContent value="other" className="mt-4">
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
                    <TableHead className="text-right">Assign</TableHead>
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
                        {r.matchStatus === 'rejected' ? (
                          <Badge variant="outline" className="text-destructive">
                            Rejected
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Unmatched</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <AssignSelect
                            productId={r.productId}
                            canonicalItems={canonicalItems}
                            disabled={isPending || noCanonical}
                            onAssign={(id, cid) => run(() => assignMatch(id, cid))}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
