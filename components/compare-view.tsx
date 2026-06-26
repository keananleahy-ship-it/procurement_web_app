'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
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
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import { formatCurrency, formatDate } from '@/lib/format'
import { packFamily, packInfo } from '@/lib/pack-size'
import {
  ArrowDownNarrowWide,
  CalendarClock,
  ChevronDown,
  GitCompareArrows,
  Layers,
  Lock,
  Package,
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
  // Empty set = show all containers; otherwise only the selected container keys.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // When true, expand each family chip to reveal its individual size chips.
  const [showSizes, setShowSizes] = useState(false)
  // How many comparison cards to render at once. Each card mounts a table and a
  // chart, so rendering thousands at once would freeze the browser — we page
  // through them instead and let the user load more on demand.
  const PAGE_SIZE = 25
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Distinct container buckets across all offers (e.g. "205 litre",
  // "1 gal (bulk)", "Unspecified"), grouped into named families (Drum, Pail,
  // Tote, …) so closely-related sizes can be selected together.
  const { packBuckets, packFamilies } = useMemo(() => {
    type Bucket = { key: string; label: string; sort: number; familyKey: string }
    const buckets = new Map<string, Bucket>()
    const families = new Map<
      string,
      { key: string; label: string; sort: number; memberKeys: string[] }
    >()
    for (const c of comparisons) {
      for (const o of c.offers) {
        const info = packInfo(o.packSize, o.baseUnit, o.productName)
        const fam = packFamily(o.packSize, o.baseUnit, o.productName)
        if (!buckets.has(info.key)) {
          buckets.set(info.key, {
            key: info.key,
            label: info.label,
            sort: info.sort,
            familyKey: fam.key,
          })
        }
        if (!families.has(fam.key)) {
          families.set(fam.key, {
            key: fam.key,
            label: fam.label,
            sort: fam.sort,
            memberKeys: [],
          })
        }
      }
    }
    const bucketList = [...buckets.values()].sort(
      (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
    )
    // Attach sorted member buckets to each family.
    for (const b of bucketList) {
      families.get(b.familyKey)?.memberKeys.push(b.key)
    }
    const familyList = [...families.values()]
      .filter((f) => f.memberKeys.length > 0)
      .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
    return { packBuckets: bucketList, packFamilies: familyList }
  }, [comparisons])

  // Quick lookup from a bucket key to its display label (for member chips).
  const bucketLabels = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of packBuckets) m.set(b.key, b.label)
    return m
  }, [packBuckets])

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Select or clear every size in a family at once. If all members are already
  // selected, the click deselects them; otherwise it selects the whole family.
  function toggleFamily(memberKeys: string[], allSelected: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (allSelected) memberKeys.forEach((k) => next.delete(k))
      else memberKeys.forEach((k) => next.add(k))
      return next
    })
  }

  // Apply text + pack-size filters, re-rank the surviving offers in each group
  // so best/worst/savings reflect only what's visible, then order the list with
  // canonical (cross-product) comparisons first.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const result: ProductComparison[] = []
    for (const c of comparisons) {
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

      let offers = c.offers
      if (selectedKeys.size > 0) {
        offers = offers.filter((o) =>
          selectedKeys.has(packInfo(o.packSize, o.baseUnit, o.productName).key),
        )
        if (offers.length === 0) continue
      }

      // Re-rank only the still-visible, comparable offers.
      const comparable = offers
        .filter((o) => o.comparable)
        .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)
      const excluded = offers.filter((o) => !o.comparable)
      const best = comparable[0] ?? null
      const worst = comparable[comparable.length - 1] ?? null
      const vendorCount = new Set(offers.map((o) => o.vendorId)).size

      result.push({
        ...c,
        offers: [...comparable, ...excluded],
        best,
        worst,
        vendorCount,
        mixedPackSizes: new Set(comparable.map((o) => o.packSize)).size > 1,
        potentialSavings:
          best && worst ? worst.pricePerBaseUnit - best.pricePerBaseUnit : 0,
      })
    }

    // Canonical comparisons first, then multi-vendor groups, then by savings.
    return result.sort((a, b) => {
      if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1
      const aMulti = a.vendorCount > 1
      const bMulti = b.vendorCount > 1
      if (aMulti !== bMulti) return aMulti ? -1 : 1
      return b.potentialSavings - a.potentialSavings
    })
  }, [comparisons, query, selectedKeys])

  // Reset paging back to the first page whenever the result set changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query, selectedKeys])

  // Only the slice we actually render. Keeps the DOM (and the per-card charts)
  // light even when there are thousands of comparison groups.
  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

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
      <div className="flex flex-col gap-3">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products or categories"
            className="pl-9"
          />
        </div>

        {packBuckets.length > 1 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Package className="size-4" />
                Pack size
              </span>
              <Button
                size="sm"
                variant={selectedKeys.size === 0 ? 'default' : 'outline'}
                className="h-7 px-2.5 text-xs"
                onClick={() => setSelectedKeys(new Set())}
              >
                All
              </Button>
              {packFamilies.map((fam) => {
                const selectedCount = fam.memberKeys.filter((k) =>
                  selectedKeys.has(k),
                ).length
                const allSelected = selectedCount === fam.memberKeys.length
                const someSelected = selectedCount > 0
                const single = fam.memberKeys.length === 1
                return (
                  <Button
                    key={fam.key}
                    size="sm"
                    variant={allSelected ? 'default' : someSelected ? 'secondary' : 'outline'}
                    className="h-7 px-2.5 text-xs"
                    aria-pressed={allSelected}
                    onClick={() => toggleFamily(fam.memberKeys, allSelected)}
                    title={
                      single
                        ? fam.label
                        : `${fam.label} — ${fam.memberKeys.length} sizes`
                    }
                  >
                    {fam.label}
                    {!single && (
                      <span className="ml-1 tabular-nums opacity-70">
                        {someSelected
                          ? `${selectedCount}/${fam.memberKeys.length}`
                          : fam.memberKeys.length}
                      </span>
                    )}
                  </Button>
                )
              })}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                aria-expanded={showSizes}
                onClick={() => setShowSizes((s) => !s)}
              >
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform',
                    showSizes && 'rotate-180',
                  )}
                />
                {showSizes ? 'Hide sizes' : 'Show sizes'}
              </Button>
              {selectedKeys.size > 0 && (
                <span className="text-xs text-muted-foreground">
                  {filtered.length} group{filtered.length === 1 ? '' : 's'} match
                </span>
              )}
            </div>

            {showSizes && (
              <div className="flex flex-col gap-1.5 border-l-2 border-border pl-3">
                {packFamilies.map((fam) => (
                  <div
                    key={fam.key}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    <span className="w-44 shrink-0 text-xs text-muted-foreground">
                      {fam.label}
                    </span>
                    {fam.memberKeys.map((key) => {
                      const active = selectedKeys.has(key)
                      return (
                        <Button
                          key={key}
                          size="sm"
                          variant={active ? 'default' : 'outline'}
                          className="h-6 px-2 text-xs tabular-nums"
                          aria-pressed={active}
                          onClick={() => toggleKey(key)}
                        >
                          {bucketLabels.get(key) ?? key}
                        </Button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          description="No comparisons match your search and pack-size filters. Try clearing a filter."
        />
      ) : (
        <div className="scroll-pane flex max-h-[calc(100vh-16rem)] flex-col gap-6 pr-2">
          {visible.map((c) => (
          <Card key={c.key} className="shrink-0 overflow-hidden p-0">
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
                  {c.isPerEach && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Package className="size-3.5" />
                      Per-piece item — listed for reference, not price-compared
                    </span>
                  )}
                  {c.isOemOnly && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Lock className="size-3.5" />
                      OEM-specific — listed for reference, not price-compared
                    </span>
                  )}
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
                  <TableHead className="text-right">Container</TableHead>
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
                        {o.sku && (
                          <span className="block font-mono text-xs font-normal text-muted-foreground">
                            {o.sku}
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
                        {(() => {
                          const info = packInfo(
                            o.packSize,
                            o.baseUnit,
                            o.productName,
                          )
                          if (info.kind === 'unspecified') {
                            return (
                              <span className="text-muted-foreground/60">—</span>
                            )
                          }
                          if (info.kind === 'sized') {
                            return (
                              <span
                                title={`Container holds ${o.packSize} ${o.baseUnit ?? 'units'}`}
                              >
                                {o.packSize.toLocaleString(undefined, {
                                  maximumFractionDigits: 2,
                                })}{' '}
                                <span className="text-xs text-muted-foreground/70">
                                  {o.baseUnit ?? ''}
                                </span>
                              </span>
                            )
                          }
                          // bulk / decant: sold loose per unit, an intentional
                          // 1-unit basis rather than an unknown container.
                          return (
                            <span
                              title="Sold loose by the gallon (bulk/decant), not in a fixed container"
                              className="text-xs"
                            >
                              {info.label}
                            </span>
                          )
                        })()}
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
                        {o.oemExcluded ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-border text-muted-foreground"
                            title="Proprietary OEM-branded fluid (e.g. Honda/Acura genuine) — listed for reference but not cross-vendor price-compared"
                          >
                            <Lock className="size-3" />
                            OEM-specific
                          </Badge>
                        ) : o.perEachExcluded ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-border text-muted-foreground"
                            title="Per-piece item (e.g. a filter or part) — listed for reference but not price-compared on a per-gallon/pound basis"
                          >
                            <Package className="size-3" />
                            Per piece
                          </Badge>
                        ) : o.unitMismatch ? (
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
            <PackSizeCurve comparison={c} />
          </Card>
          ))}
          {hasMore && (
            <div className="flex flex-col items-center gap-2 py-2">
              <span className="text-xs text-muted-foreground">
                Showing {visible.length} of {filtered.length} comparisons
              </span>
              <Button
                variant="outline"
                onClick={() =>
                  setVisibleCount((n) =>
                    Math.min(n + PAGE_SIZE, filtered.length),
                  )
                }
              >
                Load more
              </Button>
            </div>
          )}
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

// Per-base-unit cost as a function of container size. Collapsible because it
// only adds value when an item is offered in more than one pack size.
function PackSizeCurve({ comparison }: { comparison: ProductComparison }) {
  const [open, setOpen] = useState(false)

  // Cheapest comparable offer at each distinct container size, sorted by size.
  const points = useMemo(() => {
    const bySize = new Map<number, PriceRow>()
    for (const o of comparison.offers) {
      if (!o.comparable || o.packSize <= 1) continue
      const existing = bySize.get(o.packSize)
      if (!existing || o.pricePerBaseUnit < existing.pricePerBaseUnit) {
        bySize.set(o.packSize, o)
      }
    }
    return [...bySize.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([size, offer]) => ({
        size,
        label: `${size.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}${offer.baseUnit ? ` ${offer.baseUnit}` : ''}`,
        perUnit: offer.pricePerBaseUnit,
        vendor: offer.vendorName,
      }))
  }, [comparison.offers])

  if (points.length < 2) return null

  const cheapest = points.reduce((m, p) => (p.perUnit < m.perUnit ? p : m))
  // Bulk anomaly: the cheapest per-unit price is NOT the largest container.
  const largest = points[points.length - 1]
  const bulkAnomaly = cheapest.size !== largest.size

  const config: ChartConfig = {
    perUnit: { label: `Per ${comparison.baseUnit ?? 'unit'}`, color: 'var(--chart-1)' },
  }

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          Pack-size cost curve
          {bulkAnomaly && (
            <Badge
              variant="outline"
              className="gap-1 border-warning/40 text-warning"
            >
              <TriangleAlert className="size-3" />
              Bigger isn&apos;t cheaper
            </Badge>
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="px-5 pb-5">
          <p className="mb-3 text-sm text-muted-foreground text-pretty">
            Best landed cost per {comparison.baseUnit ?? 'unit'} at each
            container size.{' '}
            {bulkAnomaly ? (
              <span className="text-warning">
                The cheapest per-unit price is the{' '}
                {cheapest.label} pack — a larger container costs more per{' '}
                {comparison.baseUnit ?? 'unit'} here.
              </span>
            ) : (
              <span>
                The {cheapest.label} pack gives the lowest per-unit cost.
              </span>
            )}
          </p>
          <ChartContainer config={config} className="h-48 w-full">
            <BarChart
              data={points}
              margin={{ left: 4, right: 8, top: 4, bottom: 4 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={11}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                fontSize={11}
                tickFormatter={(v) =>
                  formatCurrency(Number(v), comparison.offers[0]?.currency)
                }
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelKey="label"
                    formatter={(value) => (
                      <span className="tabular-nums">
                        {formatCurrency(
                          Number(value),
                          comparison.offers[0]?.currency,
                        )}{' '}
                        / {comparison.baseUnit ?? 'unit'}
                      </span>
                    )}
                  />
                }
              />
              <Bar dataKey="perUnit" radius={[4, 4, 0, 0]}>
                {points.map((p) => (
                  <Cell
                    key={p.size}
                    fill={
                      p.size === cheapest.size
                        ? 'var(--color-success)'
                        : 'var(--color-chart-1)'
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </div>
  )
}
