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
import { Check, X, Trash2, CheckCircle2, Loader2 } from 'lucide-react'
import { formatDate } from '@/lib/format'

export type StagingRow = {
  id: number
  productName: string
  vendorName: string | null
  unitPrice: string | null
  shippingCost: string
  freightTerms: string
  deliveredPrice: string | null
  minOrderQty: number
  currency: string
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

  const includable = rows.filter(
    (r) => r.include && r.unitPrice !== null && r.unitPrice !== '' && r.vendorName?.trim(),
  ).length

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

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Use</TableHead>
              <TableHead className="min-w-44">Product</TableHead>
              <TableHead className="min-w-40">Vendor</TableHead>
              <TableHead className="min-w-36">Freight</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Freight cost</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Min qty</TableHead>
              <TableHead className="w-20">Cur.</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dim = !r.include
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
                      value={r.productName}
                      onChange={(e) => patchRow(r.id, { productName: e.target.value })}
                      onBlur={(e) => persist(r.id, { productName: e.target.value })}
                    />
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
                        patchRow(r.id, { freightTerms: v })
                        persist(r.id, { freightTerms: v })
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
                      className="h-8 text-right tabular-nums"
                      type="number"
                      step="0.01"
                      min="0"
                      disabled={r.freightTerms === 'delivered'}
                      value={r.freightTerms === 'delivered' ? '' : r.shippingCost}
                      onChange={(e) => patchRow(r.id, { shippingCost: e.target.value || '0' })}
                      onBlur={(e) => persist(r.id, { shippingCost: e.target.value || '0' })}
                    />
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
                      className="h-8 text-right tabular-nums"
                      type="number"
                      min="1"
                      value={r.minOrderQty}
                      onChange={(e) => patchRow(r.id, { minOrderQty: Number(e.target.value) || 1 })}
                      onBlur={(e) => persist(r.id, { minOrderQty: Number(e.target.value) || 1 })}
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
