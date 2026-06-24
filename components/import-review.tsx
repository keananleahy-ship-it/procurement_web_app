'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  updateImportRow,
  deleteImportRow,
  commitImport,
  discardImport,
  resolveContainerGroup,
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
  sku: string | null
  unitPrice: string | null
  shippingCost: string
  freightEstimated: boolean
  freightTerms: string
  deliveredPrice: string | null
  currency: string
  unit: string | null
  packSize: string
  baseUnit: string | null
  containerRaw: string | null
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

// Price-unit aliases used to match rows when applying a flat per-unit freight
// rate. Mirrors the normalization done at import time.
const GALLON_UNIT_ALIASES = new Set([
  'usg',
  'gal',
  'gals',
  'gallon',
  'gallons',
  'us gal',
  'us gallon',
])
const POUND_UNIT_ALIASES = new Set([
  'lb',
  'lbs',
  'pound',
  'pounds',
])

function unitMatchesBasis(unit: string | null, basis: 'gal' | 'lb') {
  const u = unit?.trim().toLowerCase() ?? ''
  if (!u) return false
  return basis === 'gal' ? GALLON_UNIT_ALIASES.has(u) : POUND_UNIT_ALIASES.has(u)
}

// Effective delivered (landed) price per selling unit, mirroring the
// comparison engine: FOB adds freight to the unit price, Delivered uses the
// freight-inclusive unit price as-is, and Both uses the entered delivered
// price. Returns null when there isn't enough data to compute it.
function computeDelivered(r: StagingRow): number | null {
  const price = r.unitPrice === null || r.unitPrice === '' ? null : Number(r.unitPrice)
  if (r.freightTerms === 'delivered') return price
  if (r.freightTerms === 'both') {
    return r.deliveredPrice === null || r.deliveredPrice === ''
      ? null
      : Number(r.deliveredPrice)
  }
  // fob
  if (price === null) return null
  return price + Number(r.shippingCost || 0)
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
  const [flatFreight, setFlatFreight] = useState('')
  const [flatBasis, setFlatBasis] = useState<'gal' | 'lb'>('gal')
  const [flatFreightMsg, setFlatFreightMsg] = useState<string | null>(null)

  // The table is wider than the screen. A native scrollbar only sits at the
  // very bottom of the (tall) table, so we mirror it into a slider that stays
  // pinned to the bottom of the viewport and keep the two scroll positions in
  // sync. `scrollW` tracks the table's full width to size the slider thumb.
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const [scrollW, setScrollW] = useState(0)
  const [needsSlider, setNeedsSlider] = useState(false)

  useEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    const measure = () => {
      setScrollW(el.scrollWidth)
      setNeedsSlider(el.scrollWidth > el.clientWidth + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length, onlyFlagged])

  function syncFromTable() {
    if (tableScrollRef.current && sliderRef.current) {
      sliderRef.current.scrollLeft = tableScrollRef.current.scrollLeft
    }
  }
  function syncFromSlider() {
    if (tableScrollRef.current && sliderRef.current) {
      tableScrollRef.current.scrollLeft = sliderRef.current.scrollLeft
    }
  }

  const includable = rows.filter(
    (r) => r.include && r.unitPrice !== null && r.unitPrice !== '' && r.vendorName?.trim(),
  ).length

  const flaggedCount = rows.filter((r) => r.needsReview).length
  const visibleRows = onlyFlagged ? rows.filter((r) => r.needsReview) : rows

  // Group flagged rows that share the exact same raw container text, so one
  // definition can resolve all of them at once. Rows flagged for other reasons
  // (e.g. unit mismatch) with no container text are handled inline per row.
  const containerGroups = useMemo(() => {
    const map = new Map<
      string,
      { containerRaw: string; rows: StagingRow[] }
    >()
    for (const r of rows) {
      if (!r.needsReview) continue
      const raw = r.containerRaw?.trim()
      if (!raw) continue
      const existing = map.get(raw)
      if (existing) existing.rows.push(r)
      else map.set(raw, { containerRaw: raw, rows: [r] })
    }
    return Array.from(map.values()).sort((a, b) => b.rows.length - a.rows.length)
  }, [rows])

  // Draft definition inputs per container pattern, keyed by raw text.
  const [groupDefs, setGroupDefs] = useState<
    Record<string, { packSize: string; baseUnit: string; unit: string }>
  >({})

  function groupDef(g: { containerRaw: string; rows: StagingRow[] }) {
    const sample = g.rows[0]
    return (
      groupDefs[g.containerRaw] ?? {
        packSize: sample.packSize ?? '1',
        baseUnit: sample.baseUnit ?? '',
        unit: sample.unit ?? '',
      }
    )
  }

  function setGroupField(
    raw: string,
    def: { packSize: string; baseUnit: string; unit: string },
    field: 'packSize' | 'baseUnit' | 'unit',
    value: string,
  ) {
    setGroupDefs((prev) => ({ ...prev, [raw]: { ...def, [field]: value } }))
  }

  function applyContainerGroup(g: {
    containerRaw: string
    rows: StagingRow[]
  }) {
    const def = groupDef(g)
    const packSize = def.packSize.trim() || '1'
    const baseUnit = def.baseUnit.trim() || null
    const unit = def.unit.trim() || null
    const ids = new Set(g.rows.map((r) => r.id))
    setRows((prev) =>
      prev.map((r) =>
        ids.has(r.id)
          ? {
              ...r,
              packSize,
              baseUnit,
              unit,
              needsReview: false,
              reviewReason: null,
            }
          : r,
      ),
    )
    startTransition(() => {
      void resolveContainerGroup(meta.id, g.containerRaw, {
        packSize,
        baseUnit,
        unit,
      })
    })
  }

  function resolveReview(id: number) {
    patchRow(id, { needsReview: false })
    persist(id, { needsReview: false, reviewReason: null })
  }

  // Apply a flat per-gal / per-lb freight rate to every row whose price unit
  // matches the chosen basis. Since shippingCost is stored per selling unit on
  // the same basis as unitPrice, the rate maps directly onto shippingCost and
  // the Delivered column updates immediately.
  function applyFlatFreight() {
    setFlatFreightMsg(null)
    const rate = flatFreight.trim()
    if (rate === '' || Number.isNaN(Number(rate)) || Number(rate) < 0) {
      setFlatFreightMsg('Enter a valid freight rate.')
      return
    }
    const targets = rows.filter(
      (r) =>
        r.include &&
        r.freightTerms !== 'delivered' &&
        unitMatchesBasis(r.unit, flatBasis),
    )
    if (targets.length === 0) {
      setFlatFreightMsg(
        `No included rows priced per ${flatBasis === 'gal' ? 'gallon' : 'pound'}.`,
      )
      return
    }
    for (const r of targets) {
      patchRow(r.id, {
        shippingCost: rate,
        freightTerms: 'fob',
        freightEstimated: false,
      })
      persist(r.id, {
        shippingCost: rate,
        freightTerms: 'fob',
        freightEstimated: false,
      })
    }
    setFlatFreightMsg(
      `Applied $${rate}/${flatBasis} freight to ${targets.length} ${
        targets.length === 1 ? 'row' : 'rows'
      }.`,
    )
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

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="flat-freight"
              className="text-xs font-medium text-foreground"
            >
              Flat freight rate
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                id="flat-freight"
                className="h-8 w-28 text-right tabular-nums"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={flatFreight}
                onChange={(e) => setFlatFreight(e.target.value)}
              />
              <Select
                value={flatBasis}
                onValueChange={(v) => setFlatBasis((v as 'gal' | 'lb') ?? 'gal')}
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gal">per gallon</SelectItem>
                  <SelectItem value="lb">per pound</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={applyFlatFreight}>
            Apply to matching rows
          </Button>
          {flatFreightMsg && (
            <span className="text-xs text-muted-foreground" role="status">
              {flatFreightMsg}
            </span>
          )}
        </div>
        <p className="max-w-md text-[11px] leading-snug text-muted-foreground">
          For vendors that charge a flat per-unit freight. Sets freight per unit
          on all included FOB rows priced in the chosen unit, so they show a
          delivered price comparable to other vendors.
        </p>
      </div>

      {containerGroups.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-foreground">
                Define {containerGroups.length} container{' '}
                {containerGroups.length === 1 ? 'size' : 'sizes'} once
              </p>
              <p className="text-xs text-muted-foreground">
                These package descriptions couldn’t be parsed confidently. Set
                the pack size and unit for each below and it’s applied to every
                matching row at once.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {containerGroups.map((g) => {
              const def = groupDef(g)
              return (
                <div
                  key={g.containerRaw}
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-end"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Description
                    </span>
                    <code className="rounded bg-muted px-2 py-1 text-sm text-foreground">
                      {g.containerRaw}
                    </code>
                  </div>
                  <Badge variant="secondary" className="sm:mb-1.5">
                    {g.rows.length} {g.rows.length === 1 ? 'row' : 'rows'}
                  </Badge>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-foreground">
                      Container size
                    </label>
                    <Input
                      className="h-8 w-24 text-right tabular-nums"
                      type="number"
                      step="0.0001"
                      min="0"
                      value={def.packSize}
                      onChange={(e) =>
                        setGroupField(g.containerRaw, def, 'packSize', e.target.value)
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-foreground">
                      Container unit
                    </label>
                    <Input
                      className="h-8 w-28"
                      placeholder="e.g. quart"
                      value={def.baseUnit}
                      onChange={(e) =>
                        setGroupField(g.containerRaw, def, 'baseUnit', e.target.value)
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-foreground">
                      Price unit of measure
                    </label>
                    <Input
                      className="h-8 w-28"
                      placeholder="e.g. lb"
                      value={def.unit}
                      onChange={(e) =>
                        setGroupField(g.containerRaw, def, 'unit', e.target.value)
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    className="sm:mb-0.5"
                    onClick={() => applyContainerGroup(g)}
                  >
                    Apply to {g.rows.length} {g.rows.length === 1 ? 'row' : 'rows'}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {flaggedCount > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <AlertTriangle className="size-4 text-warning" />
            {flaggedCount} {flaggedCount === 1 ? 'row needs' : 'rows need'} review.
            Use the definitions above for container shorthand, or fix individual
            rows below.
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

      <div
        ref={tableScrollRef}
        onScroll={syncFromTable}
        className="overflow-x-auto rounded-lg border border-border bg-card"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Use</TableHead>
              <TableHead className="min-w-44">Product</TableHead>
              <TableHead className="min-w-40">Vendor</TableHead>
              <TableHead className="min-w-28">Part #</TableHead>
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
                    <Input
                      className="h-8"
                      placeholder="—"
                      value={r.sku ?? ''}
                      onChange={(e) => patchRow(r.id, { sku: e.target.value })}
                      onBlur={(e) =>
                        persist(r.id, { sku: e.target.value.trim() || null })
                      }
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
                    {r.freightTerms === 'both' ? (
                      <Input
                        className="h-8 text-right tabular-nums"
                        type="number"
                        step="0.01"
                        min="0"
                        value={r.deliveredPrice ?? ''}
                        onChange={(e) =>
                          patchRow(r.id, { deliveredPrice: e.target.value === '' ? null : e.target.value })
                        }
                        onBlur={(e) =>
                          persist(r.id, { deliveredPrice: e.target.value === '' ? null : e.target.value })
                        }
                      />
                    ) : (
                      (() => {
                        const delivered = computeDelivered(r)
                        return (
                          <div className="text-right tabular-nums text-sm">
                            {delivered === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              delivered.toFixed(2)
                            )}
                          </div>
                        )
                      })()
                    )}
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
      {needsSlider && (
        <div
          ref={sliderRef}
          onScroll={syncFromSlider}
          className="sticky bottom-0 z-10 overflow-x-auto rounded-md border border-border bg-card/95 shadow-sm backdrop-blur"
          aria-label="Scroll table horizontally"
        >
          <div style={{ width: scrollW, height: 1 }} />
        </div>
      )}
      {rows.some((r) => r.include && (!r.vendorName?.trim() || r.unitPrice === null || r.unitPrice === '')) && (
        <p className="text-xs text-muted-foreground">
          Rows missing a vendor or unit price will be skipped on import. Add the
          missing values or exclude those rows.
        </p>
      )}
    </div>
  )
}
