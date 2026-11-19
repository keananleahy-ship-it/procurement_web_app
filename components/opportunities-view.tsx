'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatCurrency, formatNumber } from '@/lib/format'
import { TRAITS } from '@/lib/traits'
import { cn } from '@/lib/utils'
import type {
  OpportunitiesData,
  OpportunityOffer,
  Purchase,
} from '@/lib/opportunities'

type Row = Purchase & {
  offers: OpportunityOffer[]
  bestHere: OpportunityOffer | null
  bestAnywhere: OpportunityOffer | null
  spend: number
  gapHere: number
  gapAnywhere: number
}

const ALL = '__all'
const TRAIT_LABEL = Object.fromEntries(TRAITS.map((t) => [t.key, t.label]))

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-40 rounded-md border border-input bg-card px-2 text-sm text-foreground"
      >
        <option value={ALL}>All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone?: 'positive' | 'warning'
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums tracking-tight',
          tone === 'positive' && 'text-emerald-700',
          tone === 'warning' && 'text-amber-700',
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}

const money0 = (v: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v)

export function OpportunitiesView({ data }: { data: OpportunitiesData }) {
  const [tab, setTab] = useState<'compared' | 'needs'>('compared')
  const [region, setRegion] = useState(ALL)
  const [location, setLocation] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [supplier, setSupplier] = useState(ALL)
  const [expanded, setExpanded] = useState<string | null>(null)

  const options = useMemo(() => {
    const uniq = (xs: (string | null)[]) =>
      [...new Set(xs.filter((x): x is string => !!x))].sort()
    return {
      regions: uniq(data.purchases.map((p) => p.region)),
      locations: uniq(data.purchases.map((p) => p.locationName)),
      categories: uniq(data.purchases.map((p) => p.category)),
      suppliers: uniq(
        Object.values(data.groups).flatMap((g) =>
          g.offers.map((o) => o.vendorName),
        ),
      ),
    }
  }, [data])

  const { rows, needs } = useMemo(() => {
    const rows: Row[] = []
    const needs: Purchase[] = []
    for (const p of data.purchases) {
      if (region !== ALL && p.region !== region) continue
      if (location !== ALL && p.locationName !== location) continue
      if (category !== ALL && p.category !== category) continue
      if (!p.groupKey) {
        needs.push(p)
        continue
      }
      const offers = (data.groups[p.groupKey]?.offers ?? []).filter(
        (o) => supplier === ALL || o.vendorName === supplier,
      )
      const bestHere = offers.find((o) => o.locationId === p.locationId) ?? null
      const bestAnywhere = offers[0] ?? null
      const paid = p.paidUnitCost
      const gap = (o: OpportunityOffer | null) =>
        paid !== null && o && !p.unitMismatch
          ? Math.max(0, paid - o.pricePerBaseUnit) * p.annualVolume
          : 0
      rows.push({
        ...p,
        offers,
        bestHere,
        bestAnywhere,
        spend: paid !== null ? paid * p.annualVolume : 0,
        gapHere: gap(bestHere),
        gapAnywhere: gap(bestAnywhere),
      })
    }
    rows.sort((a, b) => b.gapAnywhere - a.gapAnywhere || b.spend - a.spend)
    return { rows, needs }
  }, [data, region, location, category, supplier])

  const kpis = useMemo(() => {
    const covered = rows.filter((r) => r.bestAnywhere && !r.unitMismatch)
    const spend = covered.reduce((s, r) => s + r.spend, 0)
    return {
      spend,
      coveredCount: covered.length,
      gapHere: rows.reduce((s, r) => s + r.gapHere, 0),
      gapAnywhere: rows.reduce((s, r) => s + r.gapAnywhere, 0),
      needsSpend: needs.reduce(
        (s, p) => s + (p.paidUnitCost ?? 0) * p.annualVolume,
        0,
      ),
    }
  }, [rows, needs])

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Region" value={region} options={options.regions} onChange={setRegion} />
        <FilterSelect label="Location" value={location} options={options.locations} onChange={setLocation} />
        <FilterSelect label="Category" value={category} options={options.categories} onChange={setCategory} />
        <FilterSelect label="Supplier offers" value={supplier} options={options.suppliers} onChange={setSupplier} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Spend with a comparable offer"
          value={money0(kpis.spend)}
          hint={`${formatNumber(kpis.coveredCount)} product-location purchases`}
        />
        <Kpi
          label="Gap to best price at the location"
          value={money0(kpis.gapHere)}
          hint="Cheapest comparable offer already quoted to that site"
          tone="positive"
        />
        <Kpi
          label="Gap to best price in the network"
          value={money0(kpis.gapAnywhere)}
          hint="Cheapest comparable offer at any location"
          tone="positive"
        />
        <Kpi
          label="Needs characteristics"
          value={money0(kpis.needsSpend)}
          hint={`${formatNumber(needs.length)} purchases can't be grouped${
            data.unlinked.rows ? `, plus ${data.unlinked.rows} unlinked rows` : ''
          }`}
          tone="warning"
        />
      </div>

      <div role="tablist" aria-label="Purchase views" className="flex gap-1 border-b border-border">
        {(
          [
            ['compared', `Compared (${rows.length})`],
            ['needs', `Needs characteristics (${needs.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'compared' ? (
        <ComparedTable rows={rows} expanded={expanded} onToggle={setExpanded} />
      ) : (
        <NeedsTable rows={needs} />
      )}
    </div>
  )
}

function OfferCell({ offer, unit }: { offer: OpportunityOffer | null; unit: string | null }) {
  if (!offer) return <span className="text-muted-foreground">None quoted</span>
  return (
    <div className="flex flex-col">
      <span className="tabular-nums">
        {formatCurrency(offer.pricePerBaseUnit)}
        <span className="text-muted-foreground">/{unit ?? 'unit'}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {offer.vendorName}
        {offer.locationName ? ` · ${offer.locationName}` : ''}
      </span>
    </div>
  )
}

function ComparedTable({
  rows,
  expanded,
  onToggle,
}: {
  rows: Row[]
  expanded: string | null
  onToggle: (id: string | null) => void
}) {
  const visible = rows.slice(0, 300)
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No purchases match these filters.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-2" />
            <th className="px-3 py-2 font-medium">Purchased product</th>
            <th className="px-3 py-2 font-medium">Location</th>
            <th className="px-3 py-2 text-right font-medium">Volume</th>
            <th className="px-3 py-2 text-right font-medium">Paid</th>
            <th className="px-3 py-2 font-medium">Best here</th>
            <th className="px-3 py-2 font-medium">Best in network</th>
            <th className="px-3 py-2 text-right font-medium">Gap here</th>
            <th className="px-3 py-2 text-right font-medium">Gap network</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const open = expanded === r.id
            return (
              <Fragment key={r.id}>
                <tr className="border-b border-border align-top last:border-0 hover:bg-muted/30">
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => onToggle(open ? null : r.id)}
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'Show'} offers for ${r.productName}`}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </td>
                  <td className="max-w-72 px-3 py-2">
                    <div className="truncate font-medium text-foreground">{r.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.offers.length} comparable offers
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.locationName}</div>
                    {r.region && <div className="text-xs text-muted-foreground">{r.region}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(Math.round(r.annualVolume))}
                    <span className="text-xs text-muted-foreground"> {r.baseUnit ?? ''}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.paidUnitCost !== null ? formatCurrency(r.paidUnitCost) : '—'}
                    {r.paidEstimated && (
                      <div className="text-xs text-amber-700">from own quote</div>
                    )}
                  </td>
                  <td className="px-3 py-2"><OfferCell offer={r.bestHere} unit={r.baseUnit} /></td>
                  <td className="px-3 py-2"><OfferCell offer={r.bestAnywhere} unit={r.baseUnit} /></td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.unitMismatch ? <Badge variant="outline">Unit mismatch</Badge> : money0(r.gapHere)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums text-emerald-700">
                    {r.unitMismatch ? '—' : money0(r.gapAnywhere)}
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-border bg-muted/20">
                    <td />
                    <td colSpan={8} className="px-3 py-3">
                      <OfferList row={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {rows.length > visible.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Showing the top {visible.length} of {rows.length}. Narrow the filters to see more.
        </p>
      )}
    </div>
  )
}

function OfferList({ row }: { row: Row }) {
  if (row.offers.length === 0) {
    return <p className="text-sm text-muted-foreground">No comparable offers from this supplier selection.</p>
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground">
        <tr>
          <th className="py-1 pr-3 font-medium">Offered product</th>
          <th className="py-1 pr-3 font-medium">Supplier</th>
          <th className="py-1 pr-3 font-medium">Location</th>
          <th className="py-1 pr-3 text-right font-medium">Pack</th>
          <th className="py-1 pr-3 text-right font-medium">Landed $/unit</th>
          <th className="py-1 text-right font-medium">vs paid</th>
        </tr>
      </thead>
      <tbody>
        {row.offers.slice(0, 40).map((o) => {
          const own = o.productId === row.productId
          const diff = row.paidUnitCost !== null ? o.pricePerBaseUnit - row.paidUnitCost : null
          return (
            <tr key={o.priceId} className={cn('border-t border-border/60', own && 'bg-primary/5')}>
              <td className="py-1 pr-3">
                {o.productName}
                {own && <Badge variant="secondary" className="ml-2">Purchased item</Badge>}
              </td>
              <td className="py-1 pr-3">{o.vendorName}</td>
              <td className={cn('py-1 pr-3', o.locationId === row.locationId && 'font-medium')}>
                {o.locationName ?? '—'}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {o.packSize} {o.unit ?? ''}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {formatCurrency(o.pricePerBaseUnit)}
                {o.freightIncomplete && <span className="text-amber-700"> *</span>}
              </td>
              <td
                className={cn(
                  'py-1 text-right tabular-nums',
                  diff !== null && diff < 0 ? 'text-emerald-700' : 'text-muted-foreground',
                )}
              >
                {diff === null ? '—' : `${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function NeedsTable({ rows }: { rows: Purchase[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Every purchase has the characteristics this tightness needs.
      </p>
    )
  }
  const sorted = [...rows].sort(
    (a, b) => (b.paidUnitCost ?? 0) * b.annualVolume - (a.paidUnitCost ?? 0) * a.annualVolume,
  )
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        These purchases are missing a trait the current tightness requires, so they aren&apos;t compared.
        Fix them in{' '}
        <Link href="/validation" className="font-medium text-primary underline-offset-2 hover:underline">
          Catalog Validation
        </Link>
        , or set the missing trait to Ignore.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Purchased product</th>
              <th className="px-3 py-2 font-medium">Location</th>
              <th className="px-3 py-2 font-medium">Missing</th>
              <th className="px-3 py-2 text-right font-medium">Volume</th>
              <th className="px-3 py-2 text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 300).map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="max-w-80 truncate px-3 py-2 font-medium">{p.productName}</td>
                <td className="px-3 py-2">{p.locationName}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {p.missing.map((m) => (
                      <Badge key={m} variant="outline">{TRAIT_LABEL[m]}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(Math.round(p.annualVolume))} {p.baseUnit ?? ''}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {p.paidUnitCost !== null ? money0(p.paidUnitCost * p.annualVolume) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
