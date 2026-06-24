'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  updateImportRow,
  deleteImportRow,
  commitImport,
  discardImport,
} from '@/app/actions/imports'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Check,
  X,
  Trash2,
  CheckCircle2,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

export type StagingRow = {
  id: number
  productName: string
  vendorName: string | null
  unitPrice: string | null
  shippingCost: string
  freightEstimated: boolean
  freightTerms: string
  deliveredPrice: string | null
  currency: string
  unit: string | null
  packSize: string
  baseUnit: string | null
  needsReview: boolean
  reviewReason: string | null
  include: boolean
}

type ImportMeta = {
  id: number
  fileName: string
  locationName: string | null
  effectiveDate: string | null
  status: string
}

const FREIGHT_LABELS: Record<string, string> = {
  fob: 'FOB origin',
  delivered: 'Delivered',
  both: 'Both',
}

export function ImportReview({
  meta,
  rows: initialRows,
}: {
  meta: ImportMeta
  rows: StagingRow[]
}) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [isPending, startTransition] = useTransition()
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlyFlagged, setOnlyFlagged] = useState(false)

  const includable = rows.filter(
    (r) => r.include && r.unitPrice !== null && r.unitPrice !== '' && r.vendorName?.trim(),
  ).length

  const flaggedCount = rows.filter((r) => r.needsReview).length
  const visibleRows = onlyFlagged ? rows.filter((r) => r.needsReview) : rows

  function resolveReview(id: number) {
    patchRow(id, { needsReview: false })
    persist(id, { needsReview: false, reviewReason: null })
  }

  function patchRow(id: number, patch: Partial<StagingRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function persist(id: number, patch: Partial<StagingRow>) {
    startTransition(() => {
      void updateImportRow(id, patch)
    })
  }

  function handleDelete(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    startTransition(() => {
      void deleteImportRow(id)
    })
  }

  async function handleCommit() {
    setError(null)
    setCommitting(true)
    try {
      await commitImport(meta.id)
      router.push('/prices')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commit failed')
      setCommitting(false)
    }
  }

  async function handleDiscard() {
    setCommitting(true)
    try {
      await discardImport(meta.id)
      router.push('/imports')
      router.refresh()
    } catch {
      setCommitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{meta.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {meta.locationName ? `${meta.locationName} · ` : ''}Effective{' '}
            {formatDate(meta.effectiveDate)} · {includable} of {rows.length} rows
            ready to import
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleDiscard}
            disabled={committing}
          >
            <Trash2 className="size-4" />
            Discard
          </Button>
          <Button onClick={handleCommit} disabled={committing || includable === 0}>
            {committing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            Import {includable} {includable === 1 ? 'row' : 'rows'}
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {flaggedCount > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <AlertTriangle className="size-4 text-warning" />
            {flaggedCount} {flaggedCount === 1 ? 'row needs' : 'rows need'} review
            — their unit differs from the rest of the file. Check the price basis
            and pack size before importing.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOnlyFlagged((v) => !v)}
          >
            {onlyFlagged ? 'Show all rows' : 'Show only flagged'}
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Use</TableHead>
              <TableHead className="min-w-44">Product</TableHead>
              <TableHead className="min-w-40">Vendor</TableHead>
              <TableHead className="min-w-36">Freight</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="min-w-28">Unit of measure</TableHead>
              <TableHead className="text-right">Freight / unit</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Container size</TableHead>
              <TableHead className="min-w-24">Container unit</TableHead>
              <TableHead className="w-20">Cur.</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((r) => {
              const dim = !r.include
              return (
                <TableRow
                  key={r.id}
                  className={cn(
                    dim && 'opacity-50',
                    r.needsReview && 'bg-warning/10',
                  )}
                >
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
                      value={r.productName}
                      onChange={(e) => patchRow(r.id, { productName: e.target.value })}
                      onBlur={(e) => persist(r.id, { productName: e.target.value })}
                    />
                    {r.needsReview && (
                      <div className="mt-1 flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        <span className="text-[11px] leading-snug text-muted-foreground">
                          {r.reviewReason ?? 'Needs review.'}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-5 shrink-0 px-1.5 text-[11px]"
                          onClick={() => resolveReview(r.id)}
                        >
                          Mark reviewed
                        </Button>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      placeholder="Required"
                      aria-invalid={!r.vendorName?.trim()}
                      value={r.vendorName ?? ''}
                      onChange={(e) => patchRow(r.id, { vendorName: e.target.value })}
                      onBlur={(e) => persist(r.id, { vendorName: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={r.freightTerms}
                      onValueChange={(v) => {
                        const next = v ?? 'fob'
                        patchRow(r.id, { freightTerms: next })
                        persist(r.id, { freightTerms: next })
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue>
                          {(value: string) => FREIGHT_LABELS[value] ?? value}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fob">FOB origin</SelectItem>
                        <SelectItem value="delivered">Delivered</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-right tabular-nums"
                      type="number"
                      step="0.01"
                      min="0"
                      value={r.unitPrice ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, { unitPrice: e.target.value === '' ? null : e.target.value })
                      }
                      onBlur={(e) =>
                        persist(r.id, { unitPrice: e.target.value === '' ? null : e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-28"
                      placeholder="e.g. lb"
                      value={r.unit ?? ''}
                      onChange={(e) => patchRow(r.id, { unit: e.target.value })}
                      onBlur={(e) =>
                        persist(r.id, { unit: e.target.value.trim() || null })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-end gap-1">
                      <Input
                        className="h-8 text-right tabular-nums"
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={r.freightTerms === 'delivered'}
                        value={r.freightTerms === 'delivered' ? '' : r.shippingCost}
                        onChange={(e) => patchRow(r.id, { shippingCost: e.target.value || '0' })}
                        onBlur={(e) => persist(r.id, { shippingCost: e.target.value || '0' })}
                      />
                      {r.freightTerms !== 'delivered' && (
                        <Button
                          type="button"
                          variant={r.freightEstimated ? 'secondary' : 'ghost'}
                          size="sm"
                          className="h-5 px-1.5 text-[11px]"
                          aria-pressed={r.freightEstimated}
                          onClick={() => {
                            const next = !r.freightEstimated
                            patchRow(r.id, { freightEstimated: next })
                            persist(r.id, { freightEstimated: next })
                          }}
                        >
                          {r.freightEstimated ? 'Estimated' : 'Mark est.'}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 text-right tabular-nums"
                      type="number"
                      step="0.01"
                      min="0"
                      disabled={r.freightTerms !== 'both'}
                      value={r.deliveredPrice ?? ''}
                      onChange={(e) =>
                        patchRow(r.id, { deliveredPrice: e.target.value === '' ? null : e.target.value })
                      }
                      onBlur={(e) =>
                        persist(r.id, { deliveredPrice: e.target.value === '' ? null : e.target.value })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-20 text-right tabular-nums"
                      type="number"
                      step="0.0001"
                      min="0"
                      value={r.packSize}
                      onChange={(e) =>
                        patchRow(r.id, { packSize: e.target.value || '1' })
                      }
                      onBlur={(e) =>
                        persist(r.id, { packSize: e.target.value || '1' })
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
                        persist(r.id, { baseUnit: e.target.value.trim() || null })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-16 uppercase"
                      maxLength={3}
                      value={r.currency}
                      onChange={(e) => patchRow(r.id, { currency: e.target.value.toUpperCase() })}
                      onBlur={(e) => persist(r.id, { currency: e.target.value.toUpperCase() || 'USD' })}
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
      {rows.some((r) => r.include && (!r.vendorName?.trim() || r.unitPrice === null || r.unitPrice === '')) && (
        <p className="text-xs text-muted-foreground">
          Rows missing a vendor or unit price will be skipped on import. Add the
          missing values or exclude those rows.
        </p>
      )}
    </div>
  )
}
