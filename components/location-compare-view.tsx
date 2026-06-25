'use client'

import { useMemo, useState } from 'react'
import type { LocationItemRow } from '@/app/actions/comparisons'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MapPin, Info, Search, ArrowLeftRight } from 'lucide-react'

export function LocationCompareView({
  locations,
  items,
}: {
  locations: { id: number | null; name: string }[]
  items: LocationItemRow[]
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.displayName.toLowerCase().includes(q) ||
        (i.category ?? '').toLowerCase().includes(q),
    )
  }, [items, query])

  const multiLocation = items.filter((i) => i.cells.length > 1).length

  if (items.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={MapPin}
          title="No location pricing yet"
          description="Assign locations to your price entries to compare what each site pays for the same item."
        />
      </div>
    )
  }

  // Stable column order from the locations list.
  const locKey = (id: number | null) => (id === null ? 'none' : String(id))

  return (
    <div className="flex flex-col gap-6 p-6">
      {locations.length < 2 && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-pretty">
            Only one location is on record, so there&apos;s nothing to compare
            across sites yet. Tag price entries with their location (or import
            quotes for another site) and per-location pricing and arbitrage will
            appear here.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items or categories"
            className="pl-9"
          />
        </div>
        {multiLocation > 0 && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <ArrowLeftRight className="size-4" />
            {multiLocation} item{multiLocation === 1 ? '' : 's'} priced at
            multiple locations
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          description="No items match your search."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">Item</TableHead>
                  {locations.map((l) => (
                    <TableHead
                      key={locKey(l.id)}
                      className="text-right whitespace-nowrap"
                    >
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3.5 text-muted-foreground" />
                        {l.name}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead className="text-right whitespace-nowrap">
                    Spread
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => {
                  const cellByLoc = new Map(
                    item.cells.map((c) => [locKey(c.locationId), c]),
                  )
                  return (
                    <TableRow key={item.key}>
                      <TableCell className="font-medium text-foreground">
                        {item.displayName}
                        {item.category && (
                          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                            {item.category}
                          </span>
                        )}
                      </TableCell>
                      {locations.map((l) => {
                        const cell = cellByLoc.get(locKey(l.id))
                        if (!cell) {
                          return (
                            <TableCell
                              key={locKey(l.id)}
                              className="text-right text-muted-foreground/40"
                            >
                              —
                            </TableCell>
                          )
                        }
                        const isCheapest =
                          item.cells.length > 1 &&
                          cell.bestPerUnit === item.minPerUnit
                        const isDearest =
                          item.cells.length > 1 &&
                          cell.bestPerUnit === item.maxPerUnit &&
                          item.spread > 0
                        return (
                          <TableCell
                            key={locKey(l.id)}
                            className={cn(
                              'text-right tabular-nums',
                              isCheapest
                                ? 'font-semibold text-success'
                                : isDearest
                                  ? 'text-destructive'
                                  : 'text-foreground',
                            )}
                          >
                            {formatCurrency(cell.bestPerUnit, item.currency)}
                            <span className="block text-xs font-normal text-muted-foreground">
                              {cell.bestVendor}
                            </span>
                          </TableCell>
                        )
                      })}
                      <TableCell className="text-right tabular-nums">
                        {item.spread > 0 ? (
                          <span
                            className="font-medium text-primary"
                            title={`${item.dearestLocation} pays ${formatCurrency(
                              item.spread,
                              item.currency,
                            )}/${item.baseUnit ?? 'unit'} more than ${
                              item.cheapestLocation
                            }`}
                          >
                            {formatCurrency(item.spread, item.currency)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}
