'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  getAwSavingsAnalyses,
  type SavingsResult,
  type SavingsItem,
  type LocationProductLine,
  type EquivalentOpportunity,
  type PackagingOpportunity,
} from '@/app/actions/savings'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { formatCurrency, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  MapPin,
  GitCompareArrows,
  Boxes,
  TrendingDown,
  Info,
  ArrowRight,
  ChevronDown,
  PiggyBank,
  Filter,
  Check,
  Package,
} from 'lucide-react'

// Short unit label for per-unit prices ("gallon" -> "gal").
function unitAbbr(baseUnit: string | null): string {
  if (!baseUnit) return 'unit'
  const u = baseUnit.trim().toLowerCase()
  if (u === 'gallon' || u === 'gallons' || u === 'gal') return 'gal'
  if (u === 'liter' || u === 'litre' || u === 'liters') return 'L'
  return baseUnit
}

const LENS = {
  location: {
    label: 'By Location',
    icon: MapPin,
    blurb: "Each site's current price vs the best price on offer anywhere",
  },
  equivalent: {
    label: 'By Equivalent',
    icon: GitCompareArrows,
    blurb: 'Present price vs cheapest like-packaged equivalent',
  },
  packaging: {
    label: 'By Packaging',
    icon: Boxes,
    blurb: 'Same product bought in a pricier container than a cheaper format',
  },
} as const

export function SavingsView({ result }: { result: SavingsResult }) {
  // `result` is the server-rendered baseline (no vendors excluded). Toggling a
  // vendor recomputes on the server via the same action and swaps in the new
  // numbers; volume is never filtered, only the pricing targets each lens sees.
  const [data, setData] = useState<SavingsResult>(result)
  const [excluded, setExcluded] = useState<Set<number>>(
    () => new Set(result.excludedVendorIds),
  )
  const [sourcing, setSourcing] = useState<'cross-site' | 'within-site'>(
    result.equivalentSourcing,
  )
  const [basis, setBasis] = useState<'equivalent' | 'same-product'>(
    result.packagingBasis,
  )
  const [pending, startTransition] = useTransition()

  const recompute = (
    nextExcluded: Set<number>,
    nextSourcing: 'cross-site' | 'within-site' = sourcing,
    nextBasis: 'equivalent' | 'same-product' = basis,
  ) => {
    setExcluded(nextExcluded)
    setSourcing(nextSourcing)
    setBasis(nextBasis)
    const ids = [...nextExcluded]
    startTransition(async () => {
      const r = await getAwSavingsAnalyses({
        excludedVendorIds: ids,
        equivalentSourcing: nextSourcing,
        packagingBasis: nextBasis,
      })
      setData(r)
    })
  }

  const toggleVendor = (id: number) => {
    const next = new Set(excluded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    recompute(next)
  }

  const { items, totals } = data

  return (
    <div className="flex flex-col gap-6 p-6">
      <VendorToggleBar
        vendors={result.vendors}
        excluded={excluded}
        onToggle={toggleVendor}
        onReset={() => recompute(new Set())}
        pending={pending}
      />
      <SourcingToggle
        sourcing={sourcing}
        onChange={(mode) => recompute(excluded, mode)}
        pending={pending}
      />
      <PackagingBasisToggle
        basis={basis}
        onChange={(next) => recompute(excluded, sourcing, next)}
        pending={pending}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title="No AW hydraulic opportunities"
          description="With the current vendor selection there are no priced opportunities. Turn vendors back on to widen the comparison."
        />
      ) : (
        <>
          <SummaryBar totals={totals} />
          <div
            className={cn(
              'flex flex-col gap-4 transition-opacity',
              pending && 'pointer-events-none opacity-60',
            )}
          >
            {items.map((item) => (
              <ItemCard key={item.canonicalItemId} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function VendorToggleBar({
  vendors,
  excluded,
  onToggle,
  onReset,
  pending,
}: {
  vendors: SavingsResult['vendors']
  excluded: Set<number>
  onToggle: (id: number) => void
  onReset: () => void
  pending: boolean
}) {
  if (vendors.length === 0) return null
  const activeCount = vendors.length - excluded.size
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Filter className="size-4" />
          <span className="text-xs font-semibold uppercase tracking-wide">
            Vendors in comparison
          </span>
          <span className="text-xs tabular-nums text-muted-foreground/70">
            {activeCount} of {vendors.length}
          </span>
        </div>
        {excluded.size > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs font-medium text-primary transition-colors hover:underline"
          >
            Reset
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {vendors.map((v) => {
          const on = !excluded.has(v.id)
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onToggle(v.id)}
              disabled={pending}
              aria-pressed={on}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-70',
                on
                  ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                  : 'border-border bg-muted text-muted-foreground line-through hover:bg-muted/70',
              )}
            >
              <span
                className={cn(
                  'flex size-3.5 items-center justify-center rounded-full border',
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40',
                )}
              >
                {on && <Check className="size-2.5" />}
              </span>
              {v.name}
            </button>
          )
        })}
      </div>
      <p className="text-[0.625rem] text-muted-foreground/70">
        Switching a vendor off removes its quotes as a pricing target across all
        three lenses and re-sizes every opportunity. Purchased volume is
        unchanged.
      </p>
    </Card>
  )
}

function SourcingToggle({
  sourcing,
  onChange,
  pending,
}: {
  sourcing: 'cross-site' | 'within-site'
  onChange: (mode: 'cross-site' | 'within-site') => void
  pending: boolean
}) {
  const options: {
    id: 'cross-site' | 'within-site'
    label: string
    hint: string
  }[] = [
    {
      id: 'cross-site',
      label: 'Cross-site',
      hint: 'source alternatives from any location',
    },
    {
      id: 'within-site',
      label: 'Within site',
      hint: 'only alternatives available at the buying site',
    },
  ]
  const active = options.find((o) => o.id === sourcing) ?? options[0]
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-muted-foreground">
        <GitCompareArrows className="size-4" />
        <span className="text-xs font-semibold uppercase tracking-wide">
          Sourcing scope
        </span>
        <span className="text-[0.625rem] text-muted-foreground/70">
          {active.hint} · applies to By Equivalent &amp; By Packaging
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Alternative sourcing scope"
        className="inline-flex shrink-0 rounded-full border border-border bg-muted p-0.5"
      >
        {options.map((o) => {
          const on = o.id === sourcing
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending}
              onClick={() => !on && onChange(o.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-70',
                on
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function PackagingBasisToggle({
  basis,
  onChange,
  pending,
}: {
  basis: 'equivalent' | 'same-product'
  onChange: (basis: 'equivalent' | 'same-product') => void
  pending: boolean
}) {
  const options: {
    id: 'equivalent' | 'same-product'
    label: string
    hint: string
  }[] = [
    {
      id: 'equivalent',
      label: 'Any equivalent',
      hint: 'a cheaper container from any like-for-like product',
    },
    {
      id: 'same-product',
      label: 'Same product',
      hint: 'a cheaper container of the same branded product only',
    },
  ]
  const active = options.find((o) => o.id === basis) ?? options[0]
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Boxes className="size-4" />
        <span className="text-xs font-semibold uppercase tracking-wide">
          Packaging basis
        </span>
        <span className="text-[0.625rem] text-muted-foreground/70">
          {active.hint} · By Packaging only
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="By Packaging comparison basis"
        className="inline-flex shrink-0 rounded-full border border-border bg-muted p-0.5"
      >
        {options.map((o) => {
          const on = o.id === basis
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={pending}
              onClick={() => !on && onChange(o.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-70',
                on
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function SummaryBar({ totals }: { totals: SavingsResult['totals'] }) {
  const tiles = [
    { ...LENS.location, value: totals.byLocation },
    { ...LENS.equivalent, value: totals.byEquivalent },
    { ...LENS.packaging, value: totals.byPackaging },
  ]
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {tiles.map((t) => {
          const Icon = t.icon
          return (
            <Card key={t.label} className="p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon className="size-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  {t.label}
                </span>
              </div>
              <p className="mt-2 text-2xl font-semibold text-primary tabular-nums">
                {formatCurrency(t.value)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t.blurb} · per year
              </p>
            </Card>
          )
        })}
      </div>
      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p className="text-pretty">
          These three lenses each re-examine the{' '}
          <span className="font-medium text-foreground">same spend</span> from a
          different angle, so they overlap and must{' '}
          <span className="font-medium text-foreground">not be added</span>{' '}
          together. Treat each as an independent route to the same savings.
        </p>
      </div>
    </div>
  )
}

function ItemCard({ item }: { item: SavingsItem }) {
  const [open, setOpen] = useState(true)
  const unit = unitAbbr(item.baseUnit)
  const grade = item.viscosity?.replace(/^ISO\s*VG\s*/i, 'ISO ') ?? null

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">
              {item.name}
            </h2>
            {grade && (
              <Badge variant="secondary" className="shrink-0">
                {grade}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatNumber(Math.round(item.annualVolume))} {unit}/yr
            {item.totalPaidSpend !== null && (
              <> · {formatCurrency(item.totalPaidSpend)} current spend</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <LensChip label={LENS.location.label} value={item.byLocationTotal} />
          <LensChip
            label={LENS.equivalent.label}
            value={item.byEquivalent?.opportunity ?? 0}
          />
          <LensChip
            label={LENS.packaging.label}
            value={item.byPackaging.opportunity}
          />
          <ChevronDown
            className={cn(
              'size-5 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </div>
      </button>

      {open && (
        <div className="grid gap-px border-t border-border bg-border md:grid-cols-3">
          <LocationLens
            lines={item.byLocationLines}
            total={item.byLocationTotal}
            unit={unit}
          />
          <EquivalentLens data={item.byEquivalent} unit={unit} />
          <PackagingLens data={item.byPackaging} unit={unit} />
        </div>
      )}
    </Card>
  )
}

function LensChip({ label, value }: { label: string; value: number | null }) {
  const hidden = value === null
  return (
    <div className="hidden text-right sm:block">
      <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <p
        className={cn(
          'text-sm font-semibold tabular-nums',
          hidden || value === 0 ? 'text-muted-foreground' : 'text-primary',
        )}
      >
        {hidden ? 'n/a' : formatCurrency(value)}
      </p>
    </div>
  )
}

function LensHeader({
  lens,
  opportunity,
}: {
  lens: keyof typeof LENS
  opportunity: number | null
}) {
  const { label, icon: Icon, blurb } = LENS[lens]
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div>
        <div className="flex items-center gap-1.5 text-foreground">
          <Icon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{blurb}</p>
      </div>
      <div className="text-right">
        <span
          className={cn(
            'inline-flex items-center gap-1 text-sm font-semibold tabular-nums',
            opportunity && opportunity > 0
              ? 'text-primary'
              : 'text-muted-foreground',
          )}
        >
          {opportunity !== null && opportunity > 0 && (
            <TrendingDown className="size-3.5" />
          )}
          {opportunity === null ? 'n/a' : formatCurrency(opportunity)}
        </span>
        <p className="text-[0.625rem] text-muted-foreground">/yr</p>
      </div>
    </div>
  )
}

// Shared "View breakdown" toggle used by the drill-down lenses.
function DrilldownToggle({
  open,
  onToggle,
  count,
}: {
  open: boolean
  onToggle: () => void
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-border/60 py-1.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      {open ? 'Hide' : 'View'} breakdown
      <span className="text-muted-foreground/60">
        ({count} {count === 1 ? 'product' : 'products'})
      </span>
      <ChevronDown
        className={cn('size-3 transition-transform', open && 'rotate-180')}
      />
    </button>
  )
}

// A per-site volume row shared by the two drill-downs.
function SiteRow({
  name,
  volume,
  unit,
  opportunity,
  source,
  target,
}: {
  name: string
  volume: number
  unit: string
  opportunity?: number
  // where the equivalent this site would switch to is sourced from; when it
  // matches the site itself (within-site) we show "on-site" instead
  source?: string | null
  // the site-specific like-for-like replacement, shown only when it differs
  // from the line's representative target (e.g. within-site sourcing)
  target?: string | null
}) {
  const sourceLabel =
    source === undefined
      ? null
      : source === null || source === name
        ? 'on-site'
        : `from ${source}`
  return (
    <li className="flex items-center justify-between gap-2 py-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1 truncate">
          <MapPin className="size-2.5 shrink-0 text-muted-foreground/50" />
          <span className="truncate text-foreground">{name}</span>
          {sourceLabel && (
            <span className="shrink-0 rounded-sm bg-muted px-1 text-[0.5625rem] font-medium normal-case text-muted-foreground/80">
              {sourceLabel}
            </span>
          )}
        </span>
        {target && (
          <span className="truncate pl-3.5 text-[0.5625rem] normal-case text-primary/80">
            → {target}
          </span>
        )}
      </span>
      <span className="shrink-0">
        {formatNumber(Math.round(volume))} {unit}
        {opportunity !== undefined && opportunity > 0 && (
          <span className="ml-1.5 text-primary">
            {formatCurrency(opportunity)}
          </span>
        )}
      </span>
    </li>
  )
}

function LocationLens({
  lines,
  total,
  unit,
}: {
  lines: LocationProductLine[]
  total: number
  unit: string
}) {
  return (
    <div className="bg-card p-4">
      <LensHeader lens="location" opportunity={total} />
      {lines.length === 0 ? (
        <LensEmpty text="Every site is already quoted the best available price for what it buys, so there is no location pricing gap." />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {lines.map((line) => (
            <li
              key={line.productId}
              className="rounded-md border border-border/60 bg-background/40 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {line.productName}
                  </p>
                  <p className="text-[0.625rem] text-muted-foreground/70">
                    {line.packFamilyLabel} · best on offer{' '}
                    {formatCurrency(line.bestUnitCost)}/{unit} at{' '}
                    {line.bestSiteName}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    line.opportunity > 0
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatCurrency(line.opportunity)}
                </span>
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {line.sites.map((s) => (
                  <li
                    key={String(s.locationId)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
                  >
                    <span className="truncate text-foreground">
                      {s.locationName}
                    </span>
                    <span>quoted {formatCurrency(s.unitCost)}</span>
                    <ArrowRight className="size-3 shrink-0" />
                    <span className="text-foreground">
                      {formatCurrency(line.bestUnitCost)}/{unit}
                    </span>
                    <span className="text-muted-foreground/70">
                      · {formatNumber(Math.round(s.annualVolume))} {unit}/yr
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <p className="mt-2 text-[0.625rem] text-muted-foreground/70">
          Each site&apos;s current quote vs the best price on offer anywhere for
          the same product/package, on historical volume — no substitution.
        </p>
      )}
    </div>
  )
}

function EquivalentLens({
  data,
  unit,
}: {
  data: EquivalentOpportunity | null
  unit: string
}) {
  const [open, setOpen] = useState(false)
  const confLabel: Record<EquivalentOpportunity['confidence'], string> = {
    high: 'current pricing',
    mixed: 'partly paid-cost',
    low: 'mostly paid-cost',
  }
  return (
    <div className="bg-card p-4">
      <LensHeader lens="equivalent" opportunity={data?.opportunity ?? null} />
      {!data ? (
        <LensEmpty text="No cheaper like-packaged equivalent to switch to." />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
            <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
              Currently buying
            </p>
            <p className="truncate text-sm text-foreground">{data.worstLabel}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(data.worstPerUnit)}/{unit} now
            </p>
          </div>
          <div className="flex items-center justify-center">
            <ArrowRight className="size-3.5 rotate-90 text-muted-foreground" />
          </div>
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <p className="text-[0.625rem] font-medium uppercase tracking-wide text-primary/80">
              Cheapest like-for-like
            </p>
            <p className="truncate text-sm text-foreground">{data.bestLabel}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(data.bestPerUnit)}/{unit} current
            </p>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <Badge
              variant="outline"
              className={cn(
                'text-[0.625rem]',
                data.confidence === 'high'
                  ? 'border-primary/40 text-primary'
                  : data.confidence === 'low'
                    ? 'border-warning/40 text-warning'
                    : 'border-border text-muted-foreground',
              )}
            >
              {confLabel[data.confidence]}
            </Badge>
            <span className="text-[0.625rem] text-muted-foreground/70 tabular-nums">
              {formatNumber(Math.round(data.pricedVolume))} {unit}/yr priced
              {data.unpricedVolume > 0 && (
                <> · {formatNumber(Math.round(data.unpricedVolume))} unpriced</>
              )}
            </span>
          </div>

          {data.lines.length > 0 && (
            <>
              <DrilldownToggle
                open={open}
                onToggle={() => setOpen((o) => !o)}
                count={data.lines.length}
              />
              {open && (
                <ul className="flex flex-col gap-2">
                  {data.lines.map((line) => (
                    <li
                      key={String(line.productId)}
                      className="rounded-md border border-border/60 bg-background/40 px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {(() => {
                            const hasSwap =
                              line.bestEquivalentProductName !== '—' &&
                              line.savings > 0
                            return (
                              <>
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground/60">
                                    Buying
                                  </span>
                                  <span className="shrink-0 text-[0.625rem] tabular-nums text-muted-foreground/70">
                                    {formatCurrency(line.presentUnitCost)}/{unit}
                                    {line.presentBasis === 'paid-cost' && (
                                      <span className="ml-0.5 text-muted-foreground/50">
                                        paid
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <p className="truncate text-xs font-medium text-foreground">
                                  {line.productName}
                                </p>
                                {hasSwap ? (
                                  <>
                                    <div className="mt-1 flex items-baseline justify-between gap-2">
                                      <span className="flex items-center gap-1 text-[0.625rem] uppercase tracking-wide text-primary/80">
                                        <ArrowRight className="size-2.5" />
                                        Switch to
                                      </span>
                                      <span className="shrink-0 text-[0.625rem] tabular-nums text-primary/90">
                                        {formatCurrency(
                                          line.bestEquivalentUnitCost,
                                        )}
                                        /{unit}
                                      </span>
                                    </div>
                                    <p className="truncate text-xs font-medium text-primary">
                                      {line.bestEquivalentProductName}
                                    </p>
                                  </>
                                ) : (
                                  <p className="mt-1 text-[0.625rem] text-muted-foreground/60">
                                    Already the cheapest like-for-like
                                  </p>
                                )}
                                <p className="mt-1 text-[0.625rem] tabular-nums text-muted-foreground/60">
                                  {formatNumber(Math.round(line.annualVolume))}{' '}
                                  {unit}/yr
                                </p>
                              </>
                            )
                          })()}
                        </div>
                        <span
                          className={cn(
                            'shrink-0 text-xs font-semibold tabular-nums',
                            line.savings > 0
                              ? 'text-primary'
                              : 'text-muted-foreground',
                          )}
                        >
                          {formatCurrency(line.savings)}
                        </span>
                      </div>
                      {line.locations.length > 0 && (
                        <ul className="mt-1 border-t border-border/40 pt-1">
                          {line.locations.map((l) => (
                            <SiteRow
                              key={String(l.locationId)}
                              name={l.locationName}
                              volume={l.annualVolume}
                              unit={unit}
                              opportunity={l.opportunity}
                              source={l.sourceLocationName}
                              target={
                                l.opportunity > 0 &&
                                l.equivalentProductName !== '—' &&
                                l.equivalentProductName !==
                                  line.bestEquivalentProductName
                                  ? l.equivalentProductName
                                  : null
                              }
                            />
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PackagingLens({
  data,
  unit,
}: {
  data: PackagingOpportunity
  unit: string
}) {
  const [open, setOpen] = useState(false)
  const maxPer = useMemo(
    () => Math.max(...data.options.map((o) => o.cheapestPerUnit), 0.0001),
    [data.options],
  )
  return (
    <div className="bg-card p-4">
      <LensHeader lens="packaging" opportunity={data.opportunity} />
      {data.options.length === 0 ? (
        <LensEmpty text="No comparable pack formats on file." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.options.map((o) => {
            const cheapest = o.deltaFromCheapest === 0
            return (
              <li key={o.family} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span
                    className={cn(
                      'font-medium',
                      cheapest ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {o.familyLabel}
                    {cheapest && (
                      <span className="ml-1 text-[0.625rem] font-normal text-primary/80">
                        cheapest
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(o.cheapestPerUnit)}/{unit}
                    {!cheapest && (
                      <span className="ml-1 text-warning">
                        +{formatCurrency(o.deltaFromCheapest)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      cheapest ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                    style={{
                      width: `${(o.cheapestPerUnit / maxPer) * 100}%`,
                    }}
                  />
                </div>
                {o.cheapestLabel && (
                  <p className="truncate text-[0.625rem] text-muted-foreground/70">
                    best: {o.cheapestLabel} ({o.offerCount}{' '}
                    {o.offerCount === 1 ? 'quote' : 'quotes'})
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[0.625rem] text-muted-foreground/70 tabular-nums">
        {data.options.length > 1 ? (
          <>
            Cheapest container: {data.cheapestFamilyLabel}{' '}
            {formatCurrency(data.cheapestPerUnit)}/{unit}. Rates by container
            above; expand to see which volume can move to it.
          </>
        ) : (
          'Only one container format on file — no packaging switch to size.'
        )}
      </p>

      {data.breakdown.length > 0 && (
        <>
          <DrilldownToggle
            open={open}
            onToggle={() => setOpen((o) => !o)}
            count={data.breakdown.length}
          />
          {open && (
            <ul className="flex flex-col gap-2">
              {data.breakdown.map((row) => (
                <li
                  key={row.family}
                  className="rounded-md border border-border/60 bg-background/40 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {row.targetFamily ? (
                        <p className="flex items-center gap-1 text-xs font-medium text-foreground">
                          <span>{row.familyLabel}</span>
                          <ArrowRight className="size-3 shrink-0 text-primary" />
                          <span className="text-primary">
                            {row.targetFamilyLabel}
                          </span>
                        </p>
                      ) : (
                        <p className="flex items-center gap-1 text-xs font-medium text-foreground">
                          {row.familyLabel}
                          <span className="text-[0.625rem] font-normal text-muted-foreground/70">
                            lowest-cost container
                          </span>
                        </p>
                      )}
                      <p className="text-[0.625rem] tabular-nums text-muted-foreground/70">
                        {formatNumber(Math.round(row.annualVolume))} {unit}/yr
                        {row.currentBestPerUnit !== null && (
                          <>
                            {' · '}
                            {formatCurrency(row.currentBestPerUnit)}/{unit} here
                          </>
                        )}
                        {row.targetPerUnit !== null && (
                          <>
                            {' → '}
                            {formatCurrency(row.targetPerUnit)}/{unit}
                          </>
                        )}
                      </p>
                    </div>
                    {row.opportunity > 0 && (
                      <span className="shrink-0 text-right text-xs font-semibold tabular-nums text-primary">
                        {formatCurrency(row.opportunity)}
                      </span>
                    )}
                  </div>
                  {row.targetLabel && (
                    <p className="mt-0.5 truncate text-[0.625rem] text-muted-foreground/70">
                      switch to: {row.targetLabel} ({row.targetOfferCount}{' '}
                      {row.targetOfferCount === 1 ? 'quote' : 'quotes'})
                    </p>
                  )}
                  {row.products.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-1.5 border-t border-border/40 pt-1.5">
                      {row.products.map((p) => (
                        <li key={p.productId} className="flex flex-col">
                          <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
                            <span className="flex items-center gap-1 truncate">
                              <Package className="size-2.5 shrink-0 text-muted-foreground/50" />
                              <span className="truncate font-medium text-foreground">
                                {p.productName}
                              </span>
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {formatNumber(Math.round(p.annualVolume))} {unit}
                              {p.blendedPaidUnitCost !== null && (
                                <span className="ml-1 text-muted-foreground/60">
                                  @ {formatCurrency(p.blendedPaidUnitCost)}
                                </span>
                              )}
                            </span>
                          </div>
                          {p.targetFamilyLabel &&
                            p.targetPerUnit !== null &&
                            p.currentBestPerUnit !== null && (
                              <p className="flex items-center justify-between gap-2 pl-3.5 text-[0.625rem] tabular-nums text-primary/90">
                                <span className="flex items-center gap-1 truncate">
                                  <ArrowRight className="size-2.5 shrink-0" />
                                  <span className="truncate">
                                    {p.targetFamilyLabel}{' '}
                                    {formatCurrency(p.currentBestPerUnit)} →{' '}
                                    {formatCurrency(p.targetPerUnit)}/{unit}
                                  </span>
                                </span>
                                {p.opportunity > 0 && (
                                  <span className="shrink-0 font-semibold">
                                    {formatCurrency(p.opportunity)}
                                  </span>
                                )}
                              </p>
                            )}
                          {p.locations.length > 0 && (
                            <ul className="pl-3.5">
                              {p.locations.map((l) => (
                                <SiteRow
                                  key={String(l.locationId)}
                                  name={l.locationName}
                                  volume={l.annualVolume}
                                  unit={unit}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function LensEmpty({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
      {text}
    </p>
  )
}
