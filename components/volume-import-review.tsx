'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  updateVolumeImportRow,
  deleteVolumeImportRow,
  setVolumeRowMatch,
  commitVolumeImport,
  discardVolumeImport,
  rematchVolumeImport,
} from '@/app/actions/volumes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Check,
  X,
  Trash2,
  CheckCircle2,
  Loader2,
  Search,
  Link2,
  AlertCircle,
  Wand2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type VolumeStagingRow = {
  id: number
  itemName: string
  sku: string | null
  annualVolume: string | null
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
  canonicalItemId: number | null
  productId: number | null
  matchName: string | null
  matchStatus: string
  include: boolean
}

type VolumeMeta = {
  id: number
  fileName: string
  locationName: string | null
  defaultPeriod: string | null
}

type MatchTarget = { id: number; name: string }

// A searchable item picker: canonical items first (preferred), then standalone
// products, with a filter box. Used per row to confirm or fix the match.
function ItemMatchPicker({
  value,
  matched,
  canonicalItems,
  products,
  onPick,
  onClear,
}: {
  value: string | null
  matched: boolean
  canonicalItems: MatchTarget[]
  products: MatchTarget[]
  onPick: (
    target:
      | { kind: 'canonical'; id: number; name: string }
      | { kind: 'product'; id: number; name: string },
  ) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filteredCanonical = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? canonicalItems.filter((c) => c.name.toLowerCase().includes(q))
      : canonicalItems
    return list.slice(0, 30)
  }, [query, canonicalItems])

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? products.filter((p) => p.name.toLowerCase().includes(q))
      : products
    return list.slice(0, 30)
  }, [query, products])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-8 w-full justify-start gap-2 font-normal',
              !matched && 'border-warning/50 text-muted-foreground',
            )}
          />
        }
      >
        {matched ? (
          <Link2 className="size-3.5 shrink-0 text-success" />
        ) : (
          <AlertCircle className="size-3.5 shrink-0 text-warning" />
        )}
        <span className="truncate">
          {value ?? 'Choose item…'}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {matched && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onClear()
                setOpen(false)
              }}
            >
              <X className="size-3.5" />
              Clear match
            </button>
          )}
          {filteredCanonical.length > 0 && (
            <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Canonical items
            </div>
          )}
          {filteredCanonical.map((c) => (
            <button
              key={`c-${c.id}`}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onPick({ kind: 'canonical', id: c.id, name: c.name })
                setOpen(false)
              }}
            >
              <Layers />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
          {filteredProducts.length > 0 && (
            <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Products
            </div>
          )}
          {filteredProducts.map((p) => (
            <button
              key={`p-${p.id}`}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onPick({ kind: 'product', id: p.id, name: p.name })
                setOpen(false)
              }}
            >
              <Package />
              <span className="truncate">{p.name}</span>
            </button>
          ))}
          {filteredCanonical.length === 0 &&
            filteredProducts.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                No matching items.
              </p>
            )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Small inline icons (avoid extra imports cluttering the row logic).
function Layers() {
  return <span className="size-3.5 shrink-0 rounded-sm bg-primary/20" aria-hidden />
}
function Package() {
  return (
    <span className="size-3.5 shrink-0 rounded-sm bg-muted-foreground/20" aria-hidden />
  )
}

export function VolumeImportReview({
  meta,
  rows: initialRows,
  canonicalItems,
  products,
}: {
  meta: VolumeMeta
  rows: VolumeStagingRow[]
  canonicalItems: MatchTarget[]
  products: MatchTarget[]
}) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [isPending, startTransition] = useTransition()
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function isReady(r: VolumeStagingRow) {
    const hasMatch = r.canonicalItemId !== null || r.productId !== null
    const hasQty = r.annualVolume !== null && Number(r.annualVolume) > 0
    return r.include && hasMatch && hasQty
  }

  const readyCount = rows.filter(isReady).length

  function patchRow(id: number, patch: Partial<VolumeStagingRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function persist(id: number, patch: Partial<VolumeStagingRow>) {
    startTransition(() => {
      void updateVolumeImportRow(id, patch)
    })
  }

  function handlePickMatch(
    id: number,
    target:
      | { kind: 'canonical'; id: number; name: string }
      | { kind: 'product'; id: number; name: string },
  ) {
    patchRow(id, {
      canonicalItemId: target.kind === 'canonical' ? target.id : null,
      productId: target.kind === 'product' ? target.id : null,
      matchName: target.name,
      matchStatus: 'confirmed',
    })
    startTransition(() => {
      void setVolumeRowMatch(id, target)
    })
  }

  function handleClearMatch(id: number) {
    patchRow(id, {
      canonicalItemId: null,
      productId: null,
      matchName: null,
      matchStatus: 'unmatched',
    })
    startTransition(() => {
      void setVolumeRowMatch(id, { kind: 'none' })
    })
  }

  function handleDelete(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    startTransition(() => {
      void deleteVolumeImportRow(id)
    })
  }

  async function handleCommit() {
    setError(null)
    setCommitting(true)
    try {
      await commitVolumeImport(meta.id)
      router.push('/volumes')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commit failed')
      setCommitting(false)
    }
  }

  async function handleDiscard() {
    setCommitting(true)
    try {
      await discardVolumeImport(meta.id)
      router.push('/volumes')
      router.refresh()
    } catch {
      setCommitting(false)
    }
  }

  // Re-run auto-matching against the current catalog (e.g. after new price
  // imports added SKUs). Refreshes the page so the recomputed matches show.
  async function handleRematch() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await rematchVolumeImport(meta.id)
        setRows((prev) =>
          prev.map((r) => {
            const next = res.rows.find((x) => x.id === r.id)
            return next
              ? {
                  ...r,
                  canonicalItemId: next.canonicalItemId,
                  productId: next.productId,
                  matchName: next.matchName,
                  matchStatus: next.matchStatus,
                }
              : r
          }),
        )
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Re-match failed')
      }
    })
  }

  const unmatchedCount = rows.filter(
    (r) => r.include && r.canonicalItemId === null && r.productId === null,
  ).length

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{meta.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {meta.locationName ? `${meta.locationName} · ` : ''}
            {meta.defaultPeriod ? `${meta.defaultPeriod} · ` : ''}
            {readyCount} of {rows.length} rows ready to apply
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleRematch}
            disabled={committing || isPending}
            title="Re-run auto-matching against the current catalog"
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            Re-match
          </Button>
          <Button
            variant="outline"
            onClick={handleDiscard}
            disabled={committing}
          >
            <Trash2 className="size-4" />
            Discard
          </Button>
          <Button
            onClick={handleCommit}
            disabled={committing || readyCount === 0}
          >
            {committing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            Apply {readyCount} {readyCount === 1 ? 'row' : 'rows'}
          </Button>
        </div>
      </div>

      {unmatchedCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-sm text-pretty text-muted-foreground">
            {unmatchedCount} {unmatchedCount === 1 ? 'row is' : 'rows are'} not
            matched to an item yet. Use the item picker on each row to link it to
            a canonical item or product. Unmatched rows are skipped when you
            apply — they won&apos;t weight any comparison.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Use</TableHead>
              <TableHead className="min-w-44">Item (as in file)</TableHead>
              <TableHead className="min-w-56">Matched to</TableHead>
              <TableHead className="text-right">Annual qty</TableHead>
              <TableHead className="min-w-24">Unit</TableHead>
              <TableHead className="text-right">Avg unit cost</TableHead>
              <TableHead className="min-w-28">Period</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dim = !r.include
              const matched =
                r.canonicalItemId !== null || r.productId !== null
              return (
                <TableRow key={r.id} className={dim ? 'opacity-50' : undefined}>
                  <TableCell>
                    <Button
                      variant={r.include ? 'secondary' : 'ghost'}
                      size="icon-sm"
                      aria-label={r.include ? 'Exclude row' : 'Include row'}
                      onClick={() => {
                        const next = !r.include
                        patchRow(r.id, { include: next })
                        persist(r.id, { include: next })
                      }}
                    >
                      {r.include ? (
                        <Check className="size-3.5 text-success" />
                      ) : (
                        <X className="size-3.5" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      value={r.itemName}
                      onChange={(e) =>
                        patchRow(r.id, { itemName: e.target.value })
                      }
                      onBlur={(e) =>
                        persist(r.id, { itemName: e.target.value })
                      }
                    />
                    {r.sku && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        SKU {r.sku}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ItemMatchPicker
                      value={r.matchName}
                      matched={matched}
                      canonicalItems={canonicalItems}
                      products={products}
                      onPick={(t) => handlePickMatch(r.id, t)}
                      onClear={() => handleClearMatch(r.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-right tabular-nums"
                      type="number"
                      step="0.01"
                      min="0"
                      value={r.annualVolume ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, {
                          annualVolume:
                            e.target.value === '' ? null : e.target.value,
                        })
                      }
                      onBlur={(e) =>
                        persist(r.id, {
                          annualVolume:
                            e.target.value === '' ? null : e.target.value,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-24"
                      placeholder="unit"
                      value={r.baseUnit ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, { baseUnit: e.target.value })
                      }
                      onBlur={(e) =>
                        persist(r.id, {
                          baseUnit: e.target.value.trim() || null,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-right tabular-nums"
                      type="number"
                      step="0.0001"
                      min="0"
                      placeholder="—"
                      value={r.baselineUnitCost ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, {
                          baselineUnitCost:
                            e.target.value === '' ? null : e.target.value,
                        })
                      }
                      onBlur={(e) =>
                        persist(r.id, {
                          baselineUnitCost:
                            e.target.value === '' ? null : e.target.value,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      placeholder={meta.defaultPeriod ?? 'e.g. TTM'}
                      value={r.period ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, { period: e.target.value })
                      }
                      onBlur={(e) =>
                        persist(r.id, {
                          period: e.target.value.trim() || null,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete row"
                      disabled={isPending}
                      onClick={() => handleDelete(r.id)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Avg unit cost is what you actually paid per unit. When present, it
        becomes the savings baseline (your cost vs. the best available quote);
        rows without a cost fall back to the vendor-to-vendor price spread.
        Applying replaces any earlier uploaded volume for the same item, this
        location, and period.
      </p>
    </div>
  )
}
