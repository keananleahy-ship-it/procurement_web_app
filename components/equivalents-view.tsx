'use client'

import { useMemo, useState } from 'react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ChevronDown,
  ChevronRight,
  Info,
  Layers,
  Search,
  TriangleAlert,
  Users,
} from 'lucide-react'
import {
  DEFAULT_SPEC_DIMENSIONS,
  SPEC_DIMENSIONS,
  groupBySpec,
  type SpecDimension,
  type SpecItem,
} from '@/lib/spec-group'
import type { CanonicalSpread } from '@/app/actions/equivalents'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 25

/**
 * The dimension toggles — the control that defines what "equivalent" means.
 *
 * Rendered as the key itself rather than a set of checkboxes: reading left to
 * right it spells out the tuple being grouped on, so the effect of adding or
 * removing a dimension is legible before it is clicked.
 */
function KeyBuilder({
  active,
  onToggle,
}: {
  active: SpecDimension[]
  onToggle: (dimension: SpecDimension) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Equivalence key
        </span>
        <Tooltip>
          <TooltipTrigger
            className="text-muted-foreground"
            aria-label="How the equivalence key works"
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Products group together when every selected attribute agrees. Add
            attributes to be stricter about a swap being like-for-like; remove
            them to explore wider substitutions.
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SPEC_DIMENSIONS.map((dimension, index) => {
          const on = active.includes(dimension.key)
          return (
            <div key={dimension.key} className="flex items-center gap-1.5">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className="text-sm text-muted-foreground/40"
                >
                  +
                </span>
              )}
              {/* TooltipTrigger already renders a button, so the toggle props
                  go straight on it — nesting a button inside would be invalid
                  markup and break keyboard focus. */}
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={() => onToggle(dimension.key)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-sm font-medium transition-colors',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground',
                  )}
                >
                  {dimension.label}
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {dimension.hint}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A single number plus its meaning, used in the summary strip. */
function Stat({
  value,
  label,
  tone = 'default',
}: {
  value: string | number
  label: string
  tone?: 'default' | 'muted'
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'muted' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function EquivalentsView({
  items,
  spreads,
}: {
  items: SpecItem[]
  spreads: CanonicalSpread[]
}) {
  const [active, setActive] = useState<SpecDimension[]>(
    DEFAULT_SPEC_DIMENSIONS,
  )
  const [query, setQuery] = useState('')
  const [crossSupplierOnly, setCrossSupplierOnly] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [visible, setVisible] = useState(PAGE_SIZE)

  function toggle(dimension: SpecDimension) {
    setActive((prev) =>
      prev.includes(dimension)
        ? prev.filter((d) => d !== dimension)
        : // Keep the canonical hierarchy order regardless of click order, so
          // the key reads consistently and the group labels stay stable.
          SPEC_DIMENSIONS.map((d) => d.key).filter(
            (d) => d === dimension || prev.includes(d),
          ),
    )
    setVisible(PAGE_SIZE)
    setExpanded(null)
  }

  const { groups, unkeyable } = useMemo(
    () => groupBySpec(items, active),
    [items, active],
  )

  // A group is only an opportunity when two different suppliers offer the spec;
  // same-supplier groups are pack or branding variants of one purchase.
  const crossSupplier = useMemo(
    () => groups.filter((g) => g.suppliers.length > 1),
    [groups],
  )

  const shown = useMemo(() => {
    const base = crossSupplierOnly ? crossSupplier : groups
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter(
      (g) =>
        g.label.toLowerCase().includes(q) ||
        g.suppliers.some((s) => s.toLowerCase().includes(q)) ||
        g.items.some((i) => i.name.toLowerCase().includes(q)),
    )
  }, [groups, crossSupplier, crossSupplierOnly, query])

  const coveredProducts = crossSupplier.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
        <KeyBuilder active={active} onToggle={toggle} />

        {active.length === 0 ? (
          <p className="text-sm text-destructive">
            Select at least one attribute to group by.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3 border-t border-border pt-3">
            <Stat value={groups.length} label="Spec groups" />
            <Stat
              value={crossSupplier.length}
              label="With 2+ suppliers"
            />
            <Stat value={coveredProducts} label="Products with alternatives" />
            <Stat
              tone="muted"
              value={unkeyable.length}
              label="Missing an attribute"
            />
          </div>
        )}
      </div>

      <Tabs defaultValue="groups">
        <TabsList>
          <TabsTrigger value="groups">
            <Layers className="size-4" />
            Equivalents
          </TabsTrigger>
          <TabsTrigger value="spreads">
            <TriangleAlert className="size-4" />
            Grouping conflicts
            {spreads.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {spreads.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="groups" className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setVisible(PAGE_SIZE)
                }}
                placeholder="Search spec, supplier or product"
                className="pl-8"
                aria-label="Search equivalent groups"
              />
            </div>
            <Button
              type="button"
              variant={crossSupplierOnly ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setCrossSupplierOnly((v) => !v)
                setVisible(PAGE_SIZE)
              }}
              aria-pressed={crossSupplierOnly}
            >
              <Users className="size-4" />
              2+ suppliers only
            </Button>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {/* Name the actual cause: suggesting a looser key is wrong advice
                  when the search term or supplier filter is what excluded
                  everything. */}
              {active.length === 0
                ? 'Select an attribute above to group products.'
                : query.trim()
                  ? `No groups match "${query.trim()}". Clear the search to see all groups.`
                  : crossSupplierOnly
                    ? 'No spec is currently offered by two or more suppliers. Remove an attribute from the key to loosen the comparison, or turn off the supplier filter.'
                    : 'No groups match. Try removing an attribute from the key to loosen the comparison.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.slice(0, visible).map((group) => {
                const open = expanded === group.key
                return (
                  <div
                    key={group.key}
                    className="rounded-lg border border-border bg-card"
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : group.key)}
                      aria-expanded={open}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left"
                    >
                      {open ? (
                        <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="text-sm font-medium text-foreground">
                          {group.label}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {group.suppliers.map((s) => (
                            <Badge
                              key={s}
                              variant="outline"
                              className="text-xs font-normal"
                            >
                              {s}
                            </Badge>
                          ))}
                          {/* ~30% of products have no supplier recorded. Say so
                              rather than letting the badge list imply the
                              supplier set is complete. Worded as "products"
                              because a bare "+4" sitting among supplier badges
                              reads as four more suppliers. */}
                          {group.unattributed > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {group.unattributed} product
                              {group.unattributed === 1 ? '' : 's'} with no
                              supplier
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {group.items.length} products
                      </span>
                    </button>

                    {open && (
                      <div className="border-t border-border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[58%]">Product</TableHead>
                              <TableHead>Supplier</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.items.map((item) => (
                              <TableRow key={item.id}>
                                {/* whitespace-normal overrides TableCell's
                                    default nowrap so long pack codes wrap. */}
                                <TableCell className="font-medium break-words whitespace-normal text-foreground">
                                  {item.name}
                                </TableCell>
                                <TableCell className="break-words whitespace-normal text-muted-foreground">
                                  {item.supplier ?? '—'}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )
              })}

              {shown.length > visible && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                >
                  Show more ({visible} of {shown.length})
                </Button>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="spreads" className="mt-4 flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              These canonical items each hold products of more than one spec, so
              savings math currently compares unlike products inside a single
              group. Nothing has been changed: a spread can mean a wrong match,
              a wrong attribute on one product, or a deliberate grouping — and
              the right fix differs for each.
            </p>
          </div>

          {spreads.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No canonical item spans more than one spec.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {spreads.map((spread) => (
                <div
                  key={spread.canonicalItemId}
                  className="rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {spread.canonicalItemName}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {spread.specs.length} specs · {spread.productCount}{' '}
                      products
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {spread.specs.map((spec) => (
                      <li
                        key={spec.label}
                        className="flex flex-wrap items-baseline gap-x-2 border-l-2 border-border pl-3 text-sm"
                      >
                        <span className="font-medium text-foreground">
                          {spec.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {spec.productCount} ×, e.g. {spec.exampleName}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
