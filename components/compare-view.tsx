'use client'

import { useMemo, useState, useTransition } from 'react'
import type { ProductComparison, PriceRow } from '@/app/actions/comparisons'
import { setFreightEstimate } from '@/app/actions/prices'
import { Badge } from '@/components/ui/badge'
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
import { Card } from '@/components/ui/card'
import { DataPagination } from '@/components/data-pagination'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  packFamily,
  PACK_FAMILIES,
  type PackFamilyId,
} from '@/lib/pack-family'
import {
  ArrowDownNarrowWide,
  Boxes,
  CalendarClock,
  GitCompareArrows,
  Layers,
  Search,
  TrendingDown,
  TriangleAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export function CompareView({
  comparisons,
}: {
  comparisons: ProductComparison[]
}) {
  const [query, setQuery] = useState('')
  const [families, setFamilies] = useState<Set<PackFamilyId>>(new Set())
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 15

  // Count offers per family across the whole catalog so we only show buttons
  // for families that actually exist, and can label each with its offer count.
  const familyCounts = useMemo(() => {
    const counts = new Map<PackFamilyId, number>()
    for (const c of comparisons) {
      for (const o of c.offers) {
        const f = packFamily(o.packSize, o.baseUnit)
        counts.set(f, (counts.get(f) ?? 0) + 1)
      }
    }
    return counts
  }, [comparisons])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const result: ProductComparison[] = []
    for (const c of comparisons) {
      // Text filter first (matches product, category, or any vendor name).
      if (
        q &&
        !(
          c.displayName.toLowerCase().includes(q) ||
          (c.category ?? '').toLowerCase().includes(q) ||
          c.offers.some((o) => o.vendorName.toLowerCase().includes(q))
        )
      ) {
        continue
      }

      // No family selected → show the group unchanged.
      if (families.size === 0) {
        result.push(c)
        continue
      }

      // Hide offers outside the selected families, then re-rank best/worst
      // within what remains so the badges and savings stay accurate.
      const offers = c.offers.filter((o) =>
        families.has(packFamily(o.packSize, o.baseUnit)),
      )
      if (offers.length === 0) continue

      const comparable = offers
        .filter((o) => o.comparable)
        .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)
      const best = comparable[0] ?? null
      const worst = comparable[comparable.length - 1] ?? null
      result.push({
        ...c,
        offers,
        best,
        worst,
        vendorCount: new Set(offers.map((o) => o.vendorId)).size,
        mixedPackSizes: new Set(comparable.map((o) => o.packSize)).size > 1,
        potentialSavings:
          best && worst ? worst.pricePerBaseUnit - best.pricePerBaseUnit : 0,
      })
    }
    return result
  }, [comparisons, query, families])

  function toggleFamily(id: PackFamilyId) {
    setPage(1)
    setFamilies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )

  if (comparisons.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitCompareArrows}
          title="Nothing to compare yet"
          description="Record vendor prices for your products and they'll appear here, ranked by potential savings."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
          placeholder="Search products or categories"
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Boxes className="size-4" />
          Pack family
        </span>
        {PACK_FAMILIES.filter((f) => familyCounts.has(f.id)).map((f) => {
          const active = families.has(f.id)
          return (
            <Button
              key={f.id}
              type="button"
              size="sm"
              variant={active ? 'default' : 'outline'}
              onClick={() => toggleFamily(f.id)}
              title={f.description}
              aria-pressed={active}
              className="h-8 gap-1.5"
            >
              {f.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  active
                    ? 'bg-primary-foreground/20 text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {familyCounts.get(f.id)}
              </span>
            </Button>
          )
        })}
        {families.size > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setFamilies(new Set())
              setPage(1)
            }}
            className="h-8 text-muted-foreground"
          >
            Clear
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {query && families.size > 0
            ? `No products match “${query}” in the selected pack ${
                families.size === 1 ? 'family' : 'families'
              }.`
            : families.size > 0
              ? 'No products have offers in the selected pack families.'
              : `No products match “${query}”.`}
        </p>
      ) : (
      <div className="flex flex-col gap-6">
        {paged.map((c) => (
          <Card key={c.key} className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">
                    {c.displayName}
                  </h3>
                  {c.isCanonical && (
                    <Badge
                      variant="outline"
                      className="gap-1 border-primary/30 text-primary"
                    >
                      <Layers className="size-3" />
                      Canonical
                    </Badge>
                  )}
                  {c.category && (
                    <Badge variant="secondary">{c.category}</Badge>
                  )}
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
                  <span>
                    {c.vendorCount} vendor{c.vendorCount === 1 ? '' : 's'}
                    {c.baseUnit ? ` · per ${c.baseUnit}` : ''}
                  </span>
                  {c.mixedPackSizes && (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <Layers className="size-3.5" />
                      Mixed pack sizes — normalized
                    </span>
                  )}
                  {c.hasUnitMismatch && (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <TriangleAlert className="size-3.5" />
                      Some offers use a different unit — excluded from ranking
                    </span>
                  )}
                  {c.hasIncompleteFreight && (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <TriangleAlert className="size-3.5" />
                      Some FOB offers have no freight — add an estimate to rank
                      them
                    </span>
                  )}
                  {c.latestEffectiveDate && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock className="size-3.5" />
                      Updated {formatDate(c.latestEffectiveDate)}
                    </span>
                  )}
                </p>
              </div>
              {c.potentialSavings > 0 && (
                <div className="flex items-center gap-1.5 rounded-md bg-success/10 px-3 py-1.5 text-sm font-medium text-success">
                  <TrendingDown className="size-4" />
                  Save {formatCurrency(c.potentialSavings)} / {c.baseUnit ?? 'unit'}
                </div>
              )}
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Freight</TableHead>
                  <TableHead className="text-right">Pack</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Freight / unit</TableHead>
                  <TableHead className="text-right">Landed / unit</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <ArrowDownNarrowWide className="size-3.5" />
                      Per {c.baseUnit ?? 'base unit'}
                    </span>
                  </TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.offers.map((o) => {
                  const isBest = o.priceId === c.best?.priceId
                  const isWorst =
                    !o.unitMismatch &&
                    c.best?.priceId !== c.worst?.priceId &&
                    o.priceId === c.worst?.priceId
                  return (
                    <TableRow
                      key={o.priceId}
                      className={cn(
                        isBest && 'bg-success/5',
                        !o.comparable && 'opacity-70',
                      )}
                    >
                      <TableCell className="font-medium text-foreground">
                        {o.vendorName}
                        {c.isCanonical &&
                          o.productName !== c.displayName && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {o.productName}
                            </span>
                          )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {o.locationName ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className="font-normal"
                          title={
                            o.freightTerms === 'both'
                              ? `Vendor quoted both; using ${
                                  o.effectiveBasis === 'fob'
                                    ? 'FOB'
                                    : 'delivered'
                                } (cheaper)`
                              : undefined
                          }
                        >
                          {o.effectiveBasis === 'fob' ? 'FOB' : 'Delivered'}
                          {o.freightTerms === 'both' && (
                            <span className="ml-1 text-muted-foreground">
                              (of both)
                            </span>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {o.packSize === 1 ? (
                          o.priceBasis === 'base' ? (
                            <span title={`Priced in bulk per ${o.baseUnit ?? 'unit'}`}>
                              Bulk
                            </span>
                          ) : (
                            <span title={`Single ${o.unit ?? 'unit'}`}>×1</span>
                          )
                        ) : (
                          <span title={`${o.packSize} ${o.baseUnit ?? 'units'} per ${o.unit ?? 'unit'}`}>
                            ×{o.packSize}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        <span
                          title={
                            o.priceBasis === 'base'
                              ? `Quoted per ${o.baseUnit ?? 'base unit'}; shown per ${o.unit ?? 'selling unit'} (×${o.packSize})`
                              : undefined
                          }
                        >
                          {formatCurrency(
                            o.effectiveBasis === 'delivered' &&
                              o.deliveredPrice !== null
                              ? o.deliveredPrice
                              : o.unitPrice,
                            o.currency,
                          )}
                          {o.priceBasis === 'base' && (
                            <span className="ml-1 text-[11px] font-normal text-muted-foreground/70">
                              /{o.baseUnit ?? 'unit'}→pack
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {o.effectiveBasis === 'delivered' ? (
                          'incl.'
                        ) : o.freightIncomplete ? (
                          <FreightEstimateEditor offer={o} />
                        ) : (
                          <span className="inline-flex items-center justify-end gap-1">
                            {formatCurrency(o.shippingCost, o.currency)}
                            {o.freightEstimated && (
                              <span
                                className="text-[11px] font-medium text-warning"
                                title="User-supplied freight estimate"
                              >
                                est.
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(o.landedUnitCost, o.currency)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-semibold tabular-nums',
                          !o.comparable
                            ? 'text-muted-foreground'
                            : isBest
                              ? 'text-success'
                              : 'text-foreground',
                        )}
                      >
                        {o.unitMismatch ? (
                          <span
                            title={`Priced per ${o.baseUnit ?? 'unit'}, not per ${c.baseUnit ?? 'base unit'} — not directly comparable`}
                          >
                            {formatCurrency(o.pricePerBaseUnit, o.currency)}
                            <span className="ml-1 text-xs font-normal">
                              /{o.baseUnit ?? 'unit'}
                            </span>
                          </span>
                        ) : o.freightIncomplete && !o.comparable ? (
                          <span title="Excludes freight — landed cost understated until an estimate is added">
                            {formatCurrency(o.pricePerBaseUnit, o.currency)}
                            <span className="ml-1 text-xs font-normal">
                              ex-freight
                            </span>
                          </span>
                        ) : (
                          formatCurrency(o.pricePerBaseUnit, o.currency)
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {formatDate(o.effectiveDate)}
                      </TableCell>
                      <TableCell className="text-right">
                        {o.unitMismatch ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-warning/40 text-warning"
                            title={`This offer is priced per ${o.baseUnit ?? 'a different unit'}, so it can't be ranked against per-${c.baseUnit ?? 'base-unit'} offers`}
                          >
                            <TriangleAlert className="size-3" />
                            Unit mismatch
                          </Badge>
                        ) : o.freightIncomplete && !o.comparable ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-warning/40 text-warning"
                            title="FOB offer with no freight — add an estimated freight cost so its landed cost can be ranked fairly"
                          >
                            <TriangleAlert className="size-3" />
                            Freight missing
                          </Badge>
                        ) : isBest ? (
                          <Badge className="bg-success text-success-foreground hover:bg-success">
                            Best price
                          </Badge>
                        ) : isWorst ? (
                          <Badge variant="outline" className="text-destructive">
                            Highest
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        ))}
        <div className="rounded-lg border border-border bg-card">
          <DataPagination
            page={currentPage}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
            label="products"
          />
        </div>
      </div>
      )}
    </div>
  )
}

// Inline editor to capture an estimated per-unit inbound freight for an FOB
// offer that arrived without one, so it can be ranked against delivered offers.
function FreightEstimateEditor({ offer }: { offer: PriceRow }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [isPending, startTransition] = useTransition()
  const canEdit = useCanEdit()

  function submit() {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) {
      setOpen(false)
      return
    }
    startTransition(async () => {
      await setFreightEstimate(offer.priceId, num)
      setOpen(false)
    })
  }

  // Viewers can't supply estimates; show the missing-freight state instead.
  if (!canEdit) {
    return <span className="text-xs text-warning">no freight</span>
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-warning hover:text-warning"
        onClick={() => setOpen(true)}
      >
        Add est.
      </Button>
    )
  }

  return (
    <span className="inline-flex items-center justify-end gap-1">
      <Input
        autoFocus
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="/unit"
        className="h-7 w-20 text-right tabular-nums"
        disabled={isPending}
      />
      <Button
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={submit}
        disabled={isPending}
      >
        Save
      </Button>
    </span>
  )
}
