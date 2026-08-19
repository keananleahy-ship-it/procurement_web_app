'use client'

import { useMemo, useState } from 'react'
import type {
  SavingsResult,
  SavingsItem,
  LocationOpportunity,
  EquivalentOpportunity,
  PackagingOpportunity,
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
    blurb: 'Same item, different prices per site',
  },
  equivalent: {
    label: 'By Equivalent',
    icon: GitCompareArrows,
    blurb: 'Switch spend to a cheaper comparable',
  },
  packaging: {
    label: 'By Packaging',
    icon: Boxes,
    blurb: 'Shift to a lower-cost pack format',
  },
} as const

export function SavingsView({ result }: { result: SavingsResult }) {
  const { items, totals } = result

  if (items.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={PiggyBank}
          title="No AW hydraulic opportunities yet"
          description="Once AW hydraulic products have vendor prices and purchase volumes on file, savings opportunities will appear here."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <SummaryBar totals={totals} />
      <div className="flex flex-col gap-4">
        {items.map((item) => (
          <ItemCard key={item.canonicalItemId} item={item} />
        ))}
      </div>
    </div>
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
          <LensChip
            label={LENS.location.label}
            value={item.byLocationTotal}
          />
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
            rows={item.byLocation}
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

function LensChip({
  label,
  value,
}: {
  label: string
  value: number | null
}) {
  const hidden = value === null
  return (
    <div className="hidden text-right sm:block">
      <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </p>
      <p
        className={cn(
          'text-sm font-semibold tabular-nums',
          hidden || value === 0
            ? 'text-muted-foreground'
            : 'text-primary',
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

function LocationLens({
  rows,
  total,
  unit,
}: {
  rows: LocationOpportunity[]
  total: number
  unit: string
}) {
  return (
    <div className="bg-card p-4">
      <LensHeader lens="location" opportunity={total} />
      {rows.length === 0 ? (
        <LensEmpty text="No per-site paid cost on file to compare against the best quote." />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={String(r.locationId)}
              className="rounded-md border border-border/60 bg-background/40 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {r.locationName}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    r.opportunity > 0
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  {formatCurrency(r.opportunity)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                <span>
                  pays {formatCurrency(r.paidUnitCost)}/{unit}
                </span>
                <ArrowRight className="size-3" />
                <span className="text-foreground">
                  {formatCurrency(r.bestQuote)}/{unit}
                </span>
                <span className="text-muted-foreground/70">
                  · {formatNumber(Math.round(r.annualVolume))} {unit}/yr
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <p className="mt-2 text-[0.625rem] text-muted-foreground/70">
          Target: best available quote — {rows[0].bestQuoteLabel}
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
  return (
    <div className="bg-card p-4">
      <LensHeader lens="equivalent" opportunity={data?.opportunity ?? null} />
      {!data ? (
        <LensEmpty text="Only one comparable offer — no cheaper equivalent to switch to." />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
            <p className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
              Currently pricier
            </p>
            <p className="truncate text-sm text-foreground">{data.worstLabel}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(data.worstPerUnit)}/{unit}
            </p>
          </div>
          <div className="flex items-center justify-center">
            <ArrowRight className="size-3.5 rotate-90 text-muted-foreground" />
          </div>
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <p className="text-[0.625rem] font-medium uppercase tracking-wide text-primary/80">
              Best comparable
            </p>
            <p className="truncate text-sm text-foreground">{data.bestLabel}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(data.bestPerUnit)}/{unit}
            </p>
          </div>
          <p className="mt-1 text-[0.625rem] text-muted-foreground/70 tabular-nums">
            Spread {formatCurrency(data.spreadPerUnit)}/{unit} ×{' '}
            {formatNumber(Math.round(data.annualVolume))} {unit}/yr
          </p>
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
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[0.625rem] text-muted-foreground/70 tabular-nums">
        {data.blendedPaidUnitCost !== null ? (
          <>
            Blended paid {formatCurrency(data.blendedPaidUnitCost)}/{unit} →{' '}
            {data.cheapestFamilyLabel} {formatCurrency(data.cheapestPerUnit)}/
            {unit}
          </>
        ) : (
          'No paid baseline on file to size the switch.'
        )}
      </p>
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
