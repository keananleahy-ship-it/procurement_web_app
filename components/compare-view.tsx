'use client'

import { useCallback, useMemo, useState, useTransition } from 'react'
import type { ProductComparison, PriceRow } from '@/app/actions/comparisons'
import { setFreightEstimate } from '@/app/actions/prices'
import { submitRemovalRequest } from '@/app/actions/removal-requests'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  AttributeGroupedList,
  type GroupItem,
} from '@/components/attribute-grouped-list'
import { COMPARE_ATTRIBUTES } from '@/lib/attributes'
import { formatCurrency, formatDate, formatNumber } from '@/lib/format'
import {
  packFamily,
  PACK_FAMILIES,
  type PackFamilyId,
} from '@/lib/pack-family'
import {
  ArrowDownNarrowWide,
  ArrowRight,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  GitCompareArrows,
  Layers,
  MinusCircle,
  Search,
  TrendingDown,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export function CompareView({
  comparisons,
}: {
  comparisons: ProductComparison[]
}) {
  const [query, setQuery] = useState('')
  const [families, setFamilies] = useState<Set<PackFamilyId>>(new Set())
  // Cards are collapsed by default — only the selected ones reveal their price
  // table, keeping the list scannable when there are many products.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // The offer the user is requesting to remove from its match, if any. Opening
  // the dialog stashes the target product so the reason prompt can submit it.
  const [removalTarget, setRemovalTarget] = useState<PriceRow | null>(null)

  // Up to two individual vendor offers (by priceId) picked for a one-to-one
  // replacement analysis. Ordered so a third pick evicts the oldest.
  const [selectedPriceIds, setSelectedPriceIds] = useState<number[]>([])
  const toggleSelect = useCallback((priceId: number) => {
    setSelectedPriceIds((prev) => {
      if (prev.includes(priceId)) return prev.filter((id) => id !== priceId)
      if (prev.length < 2) return [...prev, priceId]
      // Two already picked — drop the oldest and keep this newest pick.
      return [prev[1], priceId]
    })
  }, [])

  // Index every offer across the full catalog back to its parent group, so a
  // selected offer resolves to both its own price and the group-level annual
  // volume that turns a per-unit gap into a dollar figure.
  const offerIndex = useMemo(() => {
    const m = new Map<number, SelectedOffer>()
    for (const group of comparisons) {
      for (const offer of group.offers) m.set(offer.priceId, { offer, group })
    }
    return m
  }, [comparisons])
  const selectionFull = selectedPriceIds.length >= 2
  const selectedA = selectedPriceIds[0]
    ? (offerIndex.get(selectedPriceIds[0]) ?? null)
    : null
  const selectedB = selectedPriceIds[1]
    ? (offerIndex.get(selectedPriceIds[1]) ?? null)
    : null

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
    setFamilies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Map each (filtered) comparison to a GroupItem the hierarchy nests by its
  // own attributes. Supplier and package size stay *inside* each card (that's
  // the whole point of Compare), so those two aren't offered as levels here.
  const groupItems = useMemo<GroupItem[]>(
    () =>
      filtered.map((c) => ({
        id: c.key,
        attributes: {
          category: c.category,
          application: c.application,
          subcategory: c.subcategory,
          viscosity: c.viscosity,
        },
        searchText: [c.displayName, c.category]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        node: (
          <ComparisonCard
            c={c}
            onRemove={setRemovalTarget}
            selectedPriceIds={selectedPriceIds}
            selectionFull={selectionFull}
            onToggleSelect={toggleSelect}
          />
        ),
      })),
    [filtered, selectedPriceIds, selectionFull, toggleSelect],
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
          onChange={(e) => setQuery(e.target.value)}
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
            onClick={() => setFamilies(new Set())}
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
        <AttributeGroupedList
          items={groupItems}
          available={COMPARE_ATTRIBUTES}
            defaultGroupBy={['category', 'application', 'subcategory']}
            storageKey="compare-v2"
          forceExpand={query.trim() !== '' || families.size > 0}
          itemLabel="products"
        />
      )}

      {selectedPriceIds.length > 0 && (
        <ReplacementPanel
          a={selectedA}
          b={selectedB}
          onRemove={toggleSelect}
          onClear={() => setSelectedPriceIds([])}
        />
      )}

      <RemovalRequestDialog
        offer={removalTarget}
        onClose={() => setRemovalTarget(null)}
      />
    </div>
  )
}

// One comparison card: a collapsible header summarizing the item plus, when
// expanded, the per-vendor price table. Owns its own expand state so each card
// toggles independently inside the grouped hierarchy.
function ComparisonCard({
  c,
  onRemove,
  selectedPriceIds,
  selectionFull,
  onToggleSelect,
}: {
  c: ProductComparison
  onRemove: (offer: PriceRow) => void
  selectedPriceIds: number[]
  selectionFull: boolean
  onToggleSelect: (priceId: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Whether any offer in this card is part of the active replacement selection,
  // so a collapsed card still hints that it holds a picked product.
  const hasSelection = c.offers.some((o) => selectedPriceIds.includes(o.priceId))

  return (
    <Card
      className={cn(
        'overflow-hidden p-0 transition-colors',
        hasSelection && 'border-primary ring-1 ring-primary/40',
      )}
    >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={cn(
            'flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/40',
            expanded && 'border-b border-border',
          )}
        >
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
              <div className="flex items-center gap-3">
                {c.potentialSavings > 0 && (
                  <div className="flex flex-col items-end gap-0.5 rounded-md bg-success/10 px-3 py-1.5 text-sm font-medium text-success">
                    <span className="flex items-center gap-1.5">
                      <TrendingDown className="size-4" />
                      Save {formatCurrency(c.potentialSavings)} /{' '}
                      {c.baseUnit ?? 'unit'}
                    </span>
                    {c.realizableSavings > 0 && (
                      <span className="text-xs font-normal text-success/80">
                        {formatCurrency(c.realizableSavings)}/yr ·{' '}
                        {formatNumber(Math.round(c.annualVolume))}{' '}
                        {c.baseUnit ?? 'units'}/yr
                      </span>
                    )}
                  </div>
                )}
                <ChevronDown
                  className={cn(
                    'size-5 shrink-0 text-muted-foreground transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              </div>
        </button>

      {expanded && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Select for comparison</span>
                  </TableHead>
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
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.offers.map((o) => {
                  const isBest = o.priceId === c.best?.priceId
                  const isWorst =
                    !o.unitMismatch &&
                    c.best?.priceId !== c.worst?.priceId &&
                    o.priceId === c.worst?.priceId
                  const selected = selectedPriceIds.includes(o.priceId)
                  // Only two offers can be picked; block new picks once full.
                  const selectDisabled = selectionFull && !selected
                  const offerLabel =
                    o.productName && o.productName !== o.vendorName
                      ? `${o.productName} from ${o.vendorName}`
                      : o.vendorName
                  return (
                    <TableRow
                      key={o.priceId}
                      className={cn(
                        isBest && 'bg-success/5',
                        selected && 'bg-primary/5',
                        !o.comparable && 'opacity-70',
                      )}
                    >
                      <TableCell className="pl-4">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={
                            selected
                              ? `Remove ${offerLabel} from replacement comparison`
                              : `Select ${offerLabel} for replacement comparison`
                          }
                          disabled={selectDisabled}
                          title={
                            selectDisabled
                              ? 'Two products already selected — clear one first'
                              : 'Compare as a one-to-one replacement'
                          }
                          onClick={() => onToggleSelect(o.priceId)}
                          className={cn(
                            'flex size-5 items-center justify-center rounded border transition-colors',
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-input bg-background hover:border-primary',
                            selectDisabled &&
                              'cursor-not-allowed opacity-40 hover:border-input',
                          )}
                        >
                          {selected && (
                            <Check className="size-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </TableCell>
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
                          <span title={`Priced per ${o.baseUnit ?? 'unit'}`}>
                            Bulk
                          </span>
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
                        ) : o.unitConverted ? (
                          <span
                            title={`Quoted ${formatCurrency(o.pricePerBaseUnit, o.currency)}/${o.baseUnit ?? 'unit'}; normalized to per ${c.baseUnit ?? 'base unit'} using gear-oil density`}
                          >
                            {formatCurrency(
                              o.comparablePricePerBaseUnit,
                              o.currency,
                            )}
                            <span className="ml-1 text-[11px] font-normal text-muted-foreground/70">
                              ≈ from /{o.baseUnit ?? 'unit'}
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
                        ) : o.unitConverted ? (
                          <Badge
                            variant="outline"
                            className="gap-1 text-muted-foreground"
                            title={`Normalized from per ${o.baseUnit ?? 'unit'} to per ${c.baseUnit ?? 'base unit'} (gear-oil density) so it can be compared`}
                          >
                            <GitCompareArrows className="size-3" />
                            Converted
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => onRemove(o)}
                          title="Request that this item be removed from its match"
                        >
                          <MinusCircle className="size-4" />
                          <span className="sr-only">
                            Request removal of {o.productName}
                          </span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
      )}
    </Card>
  )
}

// A specific vendor offer picked for the replacement, paired with the group it
// belongs to — the group supplies the annual purchase volume and base unit.
type SelectedOffer = { offer: PriceRow; group: ProductComparison }

// The comparable per-base-unit price for a picked offer, or null when the offer
// isn't rankable (unit mismatch or missing freight) so it can't be costed.
function offerPrice(s: SelectedOffer): number | null {
  return s.offer.comparable ? s.offer.comparablePricePerBaseUnit : null
}

// Human label for a picked offer: its own product name, falling back to the
// group name for single-product groups.
function offerLabel(s: SelectedOffer): string {
  return s.offer.productName || s.group.displayName
}

// Base unit the picked offer's comparable price is expressed in. Prices use
// comparablePricePerBaseUnit, which is always normalized to the GROUP's base
// unit, so comparability keys on the group's unit — not the offer's raw unit,
// which may differ before normalization (e.g. quoted per gallon in a per-USG
// group) and would otherwise flag a false "different units" mismatch.
function offerUnit(s: SelectedOffer): string | null {
  return s.group.baseUnit ?? s.offer.baseUnit
}

// Sticky bar summarizing a one-to-one replacement between the two selected
// vendor offers: which to keep, the per-unit delta, and the annualized dollar
// impact using the incumbent's (the pricier offer's) group purchase volume.
function ReplacementPanel({
  a,
  b,
  onRemove,
  onClear,
}: {
  a: SelectedOffer | null
  b: SelectedOffer | null
  onRemove: (priceId: number) => void
  onClear: () => void
}) {
  const analysis = useMemo(() => {
    if (!a || !b) return null
    const pa = offerPrice(a)
    const pb = offerPrice(b)
    if (pa === null || pb === null) {
      return { kind: 'no-price' as const }
    }
    // Higher price = the offer you'd switch away from (the incumbent).
    const [incumbent, replacement, incPrice, repPrice] =
      pa >= pb ? [a, b, pa, pb] : [b, a, pb, pa]
    const unitA = (offerUnit(a) ?? '').toLowerCase()
    const unitB = (offerUnit(b) ?? '').toLowerCase()
    const unitCompatible = unitA === unitB
    const perUnitSavings = incPrice - repPrice
    // Volume you'd actually convert = how much of the incumbent you buy a year.
    const annualVolume = incumbent.group.annualVolume
    return {
      kind: 'ok' as const,
      incumbent,
      replacement,
      incPrice,
      repPrice,
      perUnitSavings,
      annualVolume,
      annualSavings: perUnitSavings * annualVolume,
      baseUnit: offerUnit(incumbent) ?? offerUnit(replacement),
      unitCompatible,
    }
  }, [a, b])

  const chips = [a, b].filter(Boolean) as SelectedOffer[]

  return (
    <div className="sticky bottom-4 z-20">
      <Card className="border-primary/30 shadow-lg">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
              <GitCompareArrows className="size-4 text-primary" />
              One-to-one replacement
            </span>
            <div className="flex items-center gap-1.5">
              {chips.map((s) => (
                <Badge
                  key={s.offer.priceId}
                  variant="secondary"
                  className="max-w-[16rem] gap-1 font-normal"
                >
                  <span className="truncate">{offerLabel(s)}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(s.offer.priceId)}
                    aria-label={`Remove ${offerLabel(s)} from comparison`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onClear}
                className="h-7 text-muted-foreground"
              >
                Clear
              </Button>
            </div>
          </div>

          {!analysis && (
            <p className="text-sm text-muted-foreground">
              Select one more product to compare a one-to-one replacement.
            </p>
          )}

          {analysis?.kind === 'no-price' && (
            <p className="inline-flex items-center gap-1.5 text-sm text-warning">
              <TriangleAlert className="size-4" />
              One of the selected products has no comparable price (missing
              freight or a unit mismatch), so a replacement can&apos;t be costed.
            </p>
          )}

          {analysis?.kind === 'ok' && (
            <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
              {/* Incumbent → replacement */}
              <div className="flex flex-1 items-center gap-3">
                <ReplacementSide
                  label="Replace"
                  s={analysis.incumbent}
                  price={analysis.incPrice}
                  baseUnit={analysis.baseUnit}
                  tone="destructive"
                />
                <ArrowRight className="size-5 shrink-0 text-muted-foreground" />
                <ReplacementSide
                  label="With"
                  s={analysis.replacement}
                  price={analysis.repPrice}
                  baseUnit={analysis.baseUnit}
                  tone="success"
                />
              </div>

              {/* Savings readout */}
              <div className="flex w-full flex-col justify-center rounded-md bg-success/10 px-4 py-2 text-success lg:w-72 lg:shrink-0">
                {analysis.perUnitSavings <= 0 ? (
                  <span className="text-sm font-medium">
                    Same price — no savings from switching.
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                      <TrendingDown className="size-4" />
                      Save {formatCurrency(analysis.perUnitSavings)} /{' '}
                      {analysis.baseUnit ?? 'unit'}
                    </span>
                    {analysis.annualVolume > 0 ? (
                      <span className="text-lg font-bold tabular-nums">
                        {formatCurrency(analysis.annualSavings)}/yr
                        <span className="ml-1 text-xs font-normal text-success/80">
                          over{' '}
                          {formatNumber(Math.round(analysis.annualVolume))}{' '}
                          {analysis.baseUnit ?? 'units'}/yr
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs font-normal text-success/80">
                        No purchase volume on file for{' '}
                        {offerLabel(analysis.incumbent)} — showing per-unit only.
                      </span>
                    )}
                  </>
                )}
                {!analysis.unitCompatible && (
                  <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warning">
                    <TriangleAlert className="size-3.5" />
                    Different base units ({offerUnit(analysis.incumbent) ?? '—'}{' '}
                    vs {offerUnit(analysis.replacement) ?? '—'}) — not directly
                    comparable.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

// One side of the replacement (the offer being replaced, or its replacement):
// product name, vendor, and its per-base-unit price.
function ReplacementSide({
  label,
  s,
  price,
  baseUnit,
  tone,
}: {
  label: string
  s: SelectedOffer
  price: number
  baseUnit: string | null
  tone: 'destructive' | 'success'
}) {
  const name = offerLabel(s)
  return (
    <div className="min-w-0 flex-1 rounded-md border border-border bg-muted/20 px-3 py-2">
      <span
        className={cn(
          'text-[0.6875rem] font-semibold uppercase tracking-wide',
          tone === 'destructive' ? 'text-destructive' : 'text-success',
        )}
      >
        {label}
      </span>
      <p className="truncate text-sm font-medium text-foreground" title={name}>
        {name}
      </p>
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
        <span className="font-semibold tabular-nums text-foreground">
          {formatCurrency(price)}
          <span className="font-normal"> / {baseUnit ?? 'unit'}</span>
        </span>
        {s.offer.vendorName && <span>· {s.offer.vendorName}</span>}
      </p>
    </div>
  )
}

// Dialog that collects a reason and submits a request to remove a product from
// its match. Any signed-in user can submit; an admin approves it later.
function RemovalRequestDialog({
  offer,
  onClose,
}: {
  offer: PriceRow | null
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Reset transient state whenever a new target opens the dialog.
  const open = offer !== null
  function handleOpenChange(next: boolean) {
    if (!next) {
      onClose()
      setReason('')
      setError(null)
      setDone(false)
    }
  }

  function submit() {
    if (!offer) return
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('Please enter a reason for the removal request.')
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        await submitRemovalRequest(offer.productId, trimmed)
        setDone(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not submit request.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request match removal</DialogTitle>
          <DialogDescription>
            {done
              ? 'Your request has been submitted for admin review.'
              : 'Ask an admin to remove this item from its match. Tell them why — this also helps train future matching.'}
          </DialogDescription>
        </DialogHeader>

        {!done && offer && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium text-foreground">
                {offer.productName}
              </span>
              <span className="block text-muted-foreground">
                {offer.vendorName}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="removal-reason">Reason</Label>
              <Textarea
                id="removal-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. This is a different product than the others in this group."
                rows={3}
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={() => handleOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button onClick={submit} disabled={isPending}>
                {isPending ? 'Submitting…' : 'Submit request'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
