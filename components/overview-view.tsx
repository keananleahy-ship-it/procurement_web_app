import type {
  LocationComparison,
  ProductComparison,
} from '@/app/actions/comparisons'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/empty-state'
import { formatCurrency, formatNumber } from '@/lib/format'
import {
  Package,
  Store,
  Tags,
  PiggyBank,
  MapPin,
  TrendingDown,
} from 'lucide-react'
import Link from 'next/link'

type Stats = {
  productCount: number
  vendorCount: number
  offerCount: number
  comparableProducts: number
  totalPotentialSavings: number
}

const statCards = [
  { key: 'productCount', label: 'Products tracked', icon: Package },
  { key: 'vendorCount', label: 'Vendors', icon: Store },
  { key: 'offerCount', label: 'Price entries', icon: Tags },
] as const

export function OverviewView({
  stats,
  topComparisons,
  locationComparisons,
}: {
  stats: Stats
  topComparisons: ProductComparison[]
  locationComparisons: LocationComparison[]
}) {
  const empty = stats.offerCount === 0

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon
          return (
            <Card key={card.key} className="p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {card.label}
                </span>
                <Icon className="size-4 text-muted-foreground" />
              </div>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                {formatNumber(stats[card.key])}
              </p>
            </Card>
          )
        })}
        <Card className="border-success/30 bg-success/5 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-success">
              Potential savings
            </span>
            <PiggyBank className="size-4 text-success" />
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-success">
            {formatCurrency(stats.totalPotentialSavings)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Across {stats.comparableProducts} comparable product
            {stats.comparableProducts === 1 ? '' : 's'}
          </p>
        </Card>
      </div>

      {empty ? (
        <EmptyState
          icon={Tags}
          title="No data yet"
          description="Add products, vendors, and price entries to see savings opportunities and location comparisons here."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <Card className="p-0 lg:col-span-3">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <TrendingDown className="size-4 text-success" />
                <h2 className="text-sm font-semibold text-foreground">
                  Top savings opportunities
                </h2>
              </div>
              <Link
                href="/compare"
                className="text-sm font-medium text-primary hover:underline"
              >
                View all
              </Link>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Best vendor</TableHead>
                  <TableHead className="text-right">Best / unit</TableHead>
                  <TableHead className="text-right">Save / unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topComparisons.map((c) => (
                  <TableRow key={c.productId}>
                    <TableCell className="font-medium text-foreground">
                      {c.productName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.best?.vendorName ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground">
                      {c.best
                        ? formatCurrency(c.best.landedUnitCost, c.best.currency)
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.potentialSavings > 0 ? (
                        <span className="font-semibold text-success">
                          {formatCurrency(c.potentialSavings)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-0 lg:col-span-2">
            <div className="flex items-center gap-2 border-b border-border px-5 py-4">
              <MapPin className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">
                Acquisition cost by location
              </h2>
            </div>
            {locationComparisons.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                No location data yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Avg / unit</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locationComparisons.map((l, i) => (
                    <TableRow key={`${l.locationId ?? 'none'}-${i}`}>
                      <TableCell className="font-medium text-foreground">
                        <span className="flex items-center gap-2">
                          {l.locationName}
                          {i === 0 && locationComparisons.length > 1 && (
                            <Badge className="bg-success text-success-foreground hover:bg-success">
                              Lowest
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-foreground">
                        {formatCurrency(l.avgLandedUnitCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatCurrency(l.totalAcquisitionCost)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
