import type { SavingsPlan } from '@/app/actions/comparisons'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { formatCurrency, formatNumber } from '@/lib/format'
import {
  PiggyBank,
  TrendingDown,
  Trophy,
  ShieldAlert,
  GitCompareArrows,
  ArrowRight,
} from 'lucide-react'

export function SavingsView({ plan }: { plan: SavingsPlan }) {
  if (plan.comparableItems === 0 && plan.singleSourceCount === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitCompareArrows}
          title="No savings analysis yet"
          description="Confirm canonical matches and record prices from more than one vendor to surface savings opportunities here."
        />
      </div>
    )
  }

  const topVendor = plan.awards[0]

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Headline metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-success/30 bg-success/5 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-success">
              Total potential savings
            </span>
            <PiggyBank className="size-4 text-success" />
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-success">
            {formatCurrency(plan.totalSavingsPerContainer)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            If every item is bought from its cheapest qualifying supplier
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              Comparable items
            </span>
            <GitCompareArrows className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
            {formatNumber(plan.comparableItems)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Quoted by two or more vendors
          </p>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              Savings per unit
            </span>
            <TrendingDown className="size-4 text-muted-foreground" />
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
            {formatCurrency(plan.totalSavingsPerUnit)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Summed best-vs-worst gap across items
          </p>
        </Card>
        <Card className="border-warning/30 bg-warning/5 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-warning">
              Single-source items
            </span>
            <ShieldAlert className="size-4 text-warning" />
          </div>
          <p className="mt-3 text-3xl font-semibold tabular-nums text-warning">
            {formatNumber(plan.singleSourceCount)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only one supplier — supply &amp; price risk
          </p>
        </Card>
      </div>

      {/* Top opportunities */}
      <Card className="p-0">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <TrendingDown className="size-4 text-success" />
          <h2 className="text-sm font-semibold text-foreground">
            Top savings opportunities
          </h2>
          <span className="ml-auto text-xs text-muted-foreground">
            Ranked by savings on one container fill
          </span>
        </div>
        {plan.opportunities.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No multi-vendor price gaps found yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Switch to</TableHead>
                <TableHead>Away from</TableHead>
                <TableHead className="text-right">Best / unit</TableHead>
                <TableHead className="text-right">Save / unit</TableHead>
                <TableHead className="text-right">Save / container</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.opportunities.map((o) => (
                <TableRow key={o.key}>
                  <TableCell className="font-medium text-foreground">
                    {o.displayName}
                    {o.category && (
                      <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                        {o.category}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 font-medium text-success">
                      {o.bestVendor}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <ArrowRight className="size-3.5 text-muted-foreground/60" />
                      {o.worstVendor}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-foreground">
                    {formatCurrency(o.bestPerUnit, o.currency)}
                    <span className="text-xs text-muted-foreground">
                      {o.baseUnit ? ` /${o.baseUnit}` : ''}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-success">
                    {formatCurrency(o.savingsPerUnit, o.currency)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-success">
                    {o.packSize > 1
                      ? formatCurrency(o.savingsPerContainer, o.currency)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Vendor award scoreboard */}
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-5 py-4">
            <Trophy className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Best-price wins by vendor
            </h2>
          </div>
          {plan.awards.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              No comparable items yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Items won</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.awards.map((a) => (
                  <TableRow key={a.vendorId}>
                    <TableCell className="font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        {a.vendorName}
                        {topVendor?.vendorId === a.vendorId &&
                          plan.awards.length > 1 && (
                            <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                              Most wins
                            </Badge>
                          )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground">
                      {formatNumber(a.itemsWon)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* Single-source risk */}
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-5 py-4">
            <ShieldAlert className="size-4 text-warning" />
            <h2 className="text-sm font-semibold text-foreground">
              Single-source items
            </h2>
            <span className="ml-auto text-xs text-muted-foreground">
              Find a second supplier to gain leverage
            </span>
          </div>
          {plan.singleSource.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              Every tracked item has more than one supplier.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Sole vendor</TableHead>
                  <TableHead className="text-right">Per unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.singleSource.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-medium text-foreground">
                      {s.displayName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.vendorName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground">
                      {formatCurrency(s.perUnit, s.currency)}
                      <span className="text-xs text-muted-foreground">
                        {s.baseUnit ? ` /${s.baseUnit}` : ''}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}
