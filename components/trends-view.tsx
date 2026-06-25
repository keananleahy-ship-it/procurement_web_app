'use client'

import { useMemo, useState } from 'react'
import type { PriceTrend } from '@/app/actions/comparisons'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/empty-state'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  LineChart as LineChartIcon,
  Info,
  Search,
} from 'lucide-react'

// One item with all the vendor series that move together on a single chart.
type ItemGroup = {
  displayName: string
  baseUnit: string | null
  currency: string
  series: PriceTrend[]
}

const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]

export function TrendsView({ trends }: { trends: PriceTrend[] }) {
  const [query, setQuery] = useState('')

  // Group vendor series under their item so each chart shows all suppliers.
  const groups = useMemo(() => {
    const m = new Map<string, ItemGroup>()
    for (const t of trends) {
      const itemKey = t.key.split('::')[0]
      const g = m.get(itemKey) ?? {
        displayName: t.displayName,
        baseUnit: t.baseUnit,
        currency: t.currency,
        series: [],
      }
      g.series.push(t)
      m.set(itemKey, g)
    }
    return [...m.values()].sort(
      (a, b) =>
        Math.max(...b.series.map((s) => Math.abs(s.pctChange ?? 0))) -
        Math.max(...a.series.map((s) => Math.abs(s.pctChange ?? 0))),
    )
  }, [trends])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter(
      (g) =>
        g.displayName.toLowerCase().includes(q) ||
        g.series.some((s) => s.vendorName.toLowerCase().includes(q)),
    )
  }, [groups, query])

  // Show the explainer whenever nothing actually has a price history to chart,
  // regardless of how many distinct dates exist across unrelated series.
  const hasAnyHistory = trends.some((t) => t.points.length > 1)

  if (trends.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={LineChartIcon}
          title="No price history yet"
          description="Price trends appear once you import quotes for the same items on different dates. Import this period's prices and they'll start charting here."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {!hasAnyHistory && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-pretty">
            No item has more than one quote date yet, so each shows its current
            price. As you import quotes from future periods, this page will
            chart how each vendor&apos;s price moves and flag increases.
          </p>
        </div>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items or vendors"
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          description="No items or vendors match your search."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {filtered.map((g) => (
            <TrendCard key={g.displayName} group={g} />
          ))}
        </div>
      )}
    </div>
  )
}

function TrendCard({ group }: { group: ItemGroup }) {
  const hasHistory = group.series.some((s) => s.points.length > 1)

  // Build a merged, date-keyed dataset across all vendor series for the chart.
  const { data, config } = useMemo(() => {
    const dateMap = new Map<string, Record<string, number | string>>()
    const cfg: ChartConfig = {}
    group.series.forEach((s, i) => {
      const seriesId = `v${s.key.split('::')[1] ?? i}`
      cfg[seriesId] = {
        label: s.vendorName,
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      }
      for (const p of s.points) {
        const row = dateMap.get(p.date) ?? { date: p.date }
        row[seriesId] = p.pricePerBaseUnit
        dateMap.set(p.date, row)
      }
    })
    const rows = [...dateMap.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    )
    return { data: rows, config: cfg }
  }, [group])

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground text-balance">
            {group.displayName}
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {group.series.length} vendor
            {group.series.length === 1 ? '' : 's'}
            {group.baseUnit ? ` · per ${group.baseUnit}` : ''}
          </p>
        </div>
      </div>

      {hasHistory ? (
        <ChartContainer config={config} className="h-44 w-full">
          <LineChart data={data} margin={{ left: 4, right: 8, top: 4 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatDate(v)}
              fontSize={11}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              fontSize={11}
              tickFormatter={(v) => formatCurrency(Number(v), group.currency)}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {Object.keys(config).map((id) => (
              <Line
                key={id}
                type="monotone"
                dataKey={id}
                stroke={`var(--color-${id})`}
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
          Awaiting a second quote date to chart movement.
        </div>
      )}

      {/* Per-vendor latest price + change */}
      <div className="flex flex-col divide-y divide-border">
        {group.series.map((s, i) => (
          <div
            key={s.key}
            className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <span className="flex items-center gap-2 text-sm text-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{
                  backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
                }}
              />
              {s.vendorName}
            </span>
            <span className="flex items-center gap-3">
              <span className="tabular-nums text-foreground">
                {formatCurrency(s.latest, s.currency)}
              </span>
              <ChangeBadge pct={s.pctChange} />
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <Minus className="size-3" />
        New
      </Badge>
    )
  }
  if (Math.abs(pct) < 0.01) {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <Minus className="size-3" />
        Flat
      </Badge>
    )
  }
  const up = pct > 0
  return (
    <Badge
      variant="outline"
      className={
        up
          ? 'gap-1 border-destructive/40 text-destructive'
          : 'gap-1 border-success/40 text-success'
      }
      title={up ? 'Price increased' : 'Price decreased'}
    >
      {up ? (
        <ArrowUpRight className="size-3" />
      ) : (
        <ArrowDownRight className="size-3" />
      )}
      {Math.abs(pct).toFixed(1)}%
    </Badge>
  )
}
