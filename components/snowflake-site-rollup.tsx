'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import type { SiteHierarchyEntry } from '@/app/actions/snowflake-source'
import {
  EXCLUDE,
  type RollupLevel,
  type RollupTarget,
  type SiteRollup,
  resolveSite,
} from '@/lib/snowflake-source'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const INHERIT = '__inherit'
const fmt = (n: number) => Math.round(n).toLocaleString()
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

type Location = { id: number; name: string }

type BusinessUnitNode = { name: string | null; entries: SiteHierarchyEntry[]; qty: number }
type RegionNode = { name: string | null; units: BusinessUnitNode[]; qty: number; count: number }

function buildTree(entries: SiteHierarchyEntry[]): RegionNode[] {
  const regions = new Map<string, Map<string, SiteHierarchyEntry[]>>()
  for (const e of entries) {
    const r = e.region ?? ''
    const b = e.businessUnit ?? ''
    if (!regions.has(r)) regions.set(r, new Map())
    const units = regions.get(r)!
    if (!units.has(b)) units.set(b, [])
    units.get(b)!.push(e)
  }
  return [...regions.entries()].map(([r, units]) => {
    const unitNodes = [...units.entries()].map(([b, list]) => ({
      name: b || null,
      entries: [...list].sort((a, z) => z.qty - a.qty),
      qty: list.reduce((n, e) => n + e.qty, 0),
    }))
    unitNodes.sort((a, z) => z.qty - a.qty)
    return {
      name: r || null,
      units: unitNodes,
      qty: unitNodes.reduce((n, u) => n + u.qty, 0),
      count: unitNodes.reduce((n, u) => n + u.entries.length, 0),
    }
  })
}

export function SnowflakeSiteRollup({
  entries,
  rollup,
  onChange,
  locations,
  lookbackMonths,
}: {
  entries: SiteHierarchyEntry[]
  rollup: SiteRollup
  onChange: (next: SiteRollup) => void
  locations: Location[]
  lookbackMonths: number
}) {
  const [query, setQuery] = useState('')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const locName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations])
  const targetLabel = (t: RollupTarget | null) =>
    t === null ? 'Unassigned' : t === EXCLUDE ? 'Excluded' : (locName.get(t) ?? 'Missing location')

  const resolved = useMemo(
    () => new Map(entries.map((e) => [e, resolveSite(e, rollup)])),
    [entries, rollup],
  )

  const totals = useMemo(() => {
    const byTarget = new Map<string, { qty: number; count: number }>()
    for (const e of entries) {
      const { target } = resolved.get(e)!
      const key = target === null ? 'unassigned' : String(target)
      const t = byTarget.get(key) ?? { qty: 0, count: 0 }
      t.qty += e.qty
      t.count += 1
      byTarget.set(key, t)
    }
    return byTarget
  }, [entries, resolved])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (unassignedOnly && resolved.get(e)!.target !== null) return false
      if (!q) return true
      return [e.site, e.businessUnit, e.region].some((v) => v?.toLowerCase().includes(q))
    })
  }, [entries, resolved, query, unassignedOnly])

  const tree = useMemo(() => buildTree(visible), [visible])
  const filtering = query.trim() !== '' || unassignedOnly
  const isOpen = (key: string) => filtering || open.has(key)
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  function setRule(level: RollupLevel, value: string, v: string | null) {
    const next: SiteRollup = { ...rollup, [level]: { ...rollup[level] } }
    if (!v || v === INHERIT) delete next[level][value]
    else next[level][value] = v === EXCLUDE ? EXCLUDE : Number(v)
    onChange(next)
  }

  function RuleSelect({
    level,
    value,
    inherited,
    label,
  }: {
    level: RollupLevel
    value: string | null
    inherited: RollupTarget | null
    label: string
  }) {
    if (value === null) {
      return <span className="text-xs text-muted-foreground sm:w-52">No value to assign</span>
    }
    const own = rollup[level][value]
    const inheritText =
      level === 'region' ? 'Unassigned' : `Inherit: ${targetLabel(inherited)}`
    const items = Object.fromEntries([
      [INHERIT, inheritText],
      ...locations.map((l) => [String(l.id), l.name]),
      [EXCLUDE, 'Exclude'],
    ])
    return (
      <Select
        value={own === undefined ? INHERIT : String(own)}
        items={items}
        onValueChange={(v) => setRule(level, value, v)}
      >
        <SelectTrigger
          aria-label={label}
          size="sm"
          className={cn('w-full sm:w-52', own !== undefined && 'border-foreground/40 font-medium')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{inheritText}</SelectItem>
          {locations.map((l) => (
            <SelectItem key={l.id} value={String(l.id)}>
              {l.name}
            </SelectItem>
          ))}
          <SelectItem value={EXCLUDE}>Exclude</SelectItem>
        </SelectContent>
      </Select>
    )
  }

  const unassigned = totals.get('unassigned')
  const grandTotal = entries.reduce((n, e) => n + e.qty, 0)

  return (
    <div className="flex flex-col gap-4">
      <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Rollup totals">
        {locations.map((l) => {
          const t = totals.get(String(l.id))
          return (
            <li key={l.id} className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
              <span className="text-xs text-muted-foreground">{l.name}</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                {fmt(t?.qty ?? 0)}
              </span>
              <span className="text-xs text-muted-foreground">
                {plural(t?.count ?? 0, 'warehouse')}
              </span>
            </li>
          )
        })}
        <li
          className={cn(
            'flex flex-col gap-0.5 rounded-md border px-3 py-2',
            unassigned && unassigned.qty > 0 && 'border-amber-500/60 bg-amber-500/5',
          )}
        >
          <span className="text-xs text-muted-foreground">Unassigned</span>
          <span className="font-mono text-sm font-medium tabular-nums">
            {fmt(unassigned?.qty ?? 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            {plural(unassigned?.count ?? 0, 'warehouse')}
          </span>
        </li>
        <li className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
          <span className="text-xs text-muted-foreground">Excluded</span>
          <span className="font-mono text-sm font-medium tabular-nums">
            {fmt(totals.get(EXCLUDE)?.qty ?? 0)}
          </span>
          <span className="text-xs text-muted-foreground">
            {plural(totals.get(EXCLUDE)?.count ?? 0, 'warehouse')}
          </span>
        </li>
      </ul>
      <p className="text-xs text-muted-foreground">
        Quantity over the last {lookbackMonths} months, {fmt(grandTotal)} in total. The most
        specific rule wins: a warehouse setting overrides its business unit, which overrides
        its region.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter warehouses, business units, regions"
            aria-label="Filter warehouses"
            className="pl-8"
          />
        </div>
        <Button
          variant={unassignedOnly ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={unassignedOnly}
          onClick={() => setUnassignedOnly((v) => !v)}
        >
          Unassigned only
        </Button>
      </div>

      {tree.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {filtering ? 'No warehouses match the filter.' : 'No warehouses found in the view.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {tree.map((region) => {
            const rKey = `r:${region.name ?? ''}`
            return (
              <li key={rKey} className="flex flex-col">
                <div className="flex flex-col gap-2 bg-muted/50 px-3 py-2.5 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={() => toggle(rKey)}
                    aria-expanded={isOpen(rKey)}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn('size-4 shrink-0 transition-transform', isOpen(rKey) && 'rotate-90')}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-semibold">{region.name ?? 'No region'}</span>
                    <span className="text-xs text-muted-foreground">
                      Region · {plural(region.units.length, 'business unit')} ·{' '}
                      {plural(region.count, 'warehouse')}
                    </span>
                    <span className="ml-auto font-mono text-xs tabular-nums">{fmt(region.qty)}</span>
                  </button>
                  <RuleSelect
                    level="region"
                    value={region.name}
                    inherited={null}
                    label={`Location for region ${region.name ?? ''}`}
                  />
                </div>

                {isOpen(rKey) && (
                  <ul className="flex flex-col divide-y border-t">
                    {region.units.map((unit) => {
                      const uKey = `${rKey}|b:${unit.name ?? ''}`
                      const fromRegion = resolveSite(
                        { region: region.name, businessUnit: null, site: '' },
                        rollup,
                      ).target
                      return (
                        <li key={uKey} className="flex flex-col">
                          <div className="flex flex-col gap-2 py-2 pr-3 pl-8 sm:flex-row sm:items-center">
                            <button
                              type="button"
                              onClick={() => toggle(uKey)}
                              aria-expanded={isOpen(uKey)}
                              className="flex flex-1 items-center gap-2 text-left"
                            >
                              <ChevronRight
                                className={cn(
                                  'size-4 shrink-0 transition-transform',
                                  isOpen(uKey) && 'rotate-90',
                                )}
                                aria-hidden="true"
                              />
                              <span className="text-sm font-medium">
                                {unit.name ?? 'No business unit'}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {plural(unit.entries.length, 'warehouse')}
                              </span>
                              <span className="ml-auto font-mono text-xs tabular-nums">
                                {fmt(unit.qty)}
                              </span>
                            </button>
                            <RuleSelect
                              level="businessUnit"
                              value={unit.name}
                              inherited={fromRegion}
                              label={`Location for business unit ${unit.name ?? ''}`}
                            />
                          </div>

                          {isOpen(uKey) && (
                            <ul className="flex flex-col divide-y border-t bg-background">
                              {unit.entries.map((e) => {
                                const r = resolved.get(e)!
                                const parent = resolveSite({ ...e, site: '' }, rollup).target
                                return (
                                  <li
                                    key={`${uKey}|s:${e.site}`}
                                    className="flex flex-col gap-2 py-1.5 pr-3 pl-16 sm:flex-row sm:items-center"
                                  >
                                    <div className="flex flex-1 items-center gap-3">
                                      <span className="font-mono text-xs">{e.site || '(blank)'}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {e.lines.toLocaleString()} lines
                                        {e.lastDate ? ` · last ${e.lastDate}` : ''}
                                      </span>
                                      <span
                                        className={cn(
                                          'ml-auto font-mono text-xs tabular-nums',
                                          e.qty === 0 && 'text-muted-foreground',
                                          r.target === null && e.qty > 0 && 'text-amber-700',
                                        )}
                                      >
                                        {fmt(e.qty)}
                                      </span>
                                    </div>
                                    <RuleSelect
                                      level="site"
                                      value={e.site}
                                      inherited={parent}
                                      label={`Location for warehouse ${e.site}`}
                                    />
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
