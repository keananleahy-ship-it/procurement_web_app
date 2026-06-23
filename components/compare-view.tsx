'use client'

import { useMemo, useState } from 'react'
import type { ProductComparison } from '@/app/actions/comparisons'
import { Badge } from '@/components/ui/badge'
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
import { EmptyState } from '@/components/empty-state'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  ArrowDownNarrowWide,
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return comparisons
    return comparisons.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        (c.category ?? '').toLowerCase().includes(q) ||
        c.offers.some((o) => o.vendorName.toLowerCase().includes(q)),
    )
  }, [comparisons, query])

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
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products or categories"
          className="pl-9"
        />
      </div>

      <div className="flex flex-col gap-6">
        {filtered.map((c) => (
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
                  <TableHead className="text-right">Freight cost</TableHead>
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
                        o.unitMismatch && 'opacity-70',
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
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          <span title={`${o.packSize} ${o.baseUnit ?? 'units'} per ${o.unit ?? 'unit'}`}>
                            ×{o.packSize}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(
                          o.effectiveBasis === 'delivered' &&
                            o.deliveredPrice !== null
                            ? o.deliveredPrice
                            : o.unitPrice,
                          o.currency,
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {o.effectiveBasis === 'delivered'
                          ? 'incl.'
                          : formatCurrency(o.shippingCost, o.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(o.landedUnitCost, o.currency)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-semibold tabular-nums',
                          o.unitMismatch
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
      </div>
    </div>
  )
}
