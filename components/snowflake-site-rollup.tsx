'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Plus, Search, Trash2 } from 'lucide-react'
import type { SiteHierarchyEntry } from '@/app/actions/snowflake-source'
import {
  EXCLUDE,
  type RollupLevel,
  type RollupTarget,
  type SiteRollup,
  groupOf,
  normalizeName,
  resolveSite,
  siteRuleKey,
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

type BusinessUnitNode = {
  name: string | null
  region: string | null
  entries: SiteHierarchyEntry[]
  qty: number
}
type TopNode = {
  kind: 'group' | 'region'
  name: string | null
  units: BusinessUnitNode[]
  qty: number
  count: number
}

function unitNodes(entries: SiteHierarchyEntry[]): BusinessUnitNode[] {
  const units = new Map<string, SiteHierarchyEntry[]>()
  for (const e of entries) {
    const key = `${e.region ?? ''}\u0000${e.businessUnit ?? ''}`
    if (!units.has(key)) units.set(key, [])
    units.get(key)!.push(e)
  }
  return [...units.values()]
    .map((list) => ({
      name: list[0].businessUnit,
      region: list[0].region,
      entries: [...list].sort((a, z) => z.qty - a.qty),
      qty: list.reduce((n, e) => n + e.qty, 0),
    }))
    .sort((a, z) => z.qty - a.qty)
}

function topNode(kind: TopNode['kind'], name: string | null, list: SiteHierarchyEntry[]): TopNode {
  const units = unitNodes(list)
  return {
    kind,
    name,
    units,
    qty: units.reduce((n, u) => n + u.qty, 0),
    count: units.reduce((n, u) => n + u.entries.length, 0),
  }
}

// Platform groups first (in the order they were created), then any business
// units not in a group under their region from the view.
function buildTree(entries: SiteHierarchyEntry[], rollup: SiteRollup): TopNode[] {
  const grouped = new Map<string, SiteHierarchyEntry[]>()
  const byRegion = new Map<string, SiteHierarchyEntry[]>()
  for (const e of entries) {
    const g = groupOf(rollup, e.businessUnit)
    const bucket = g === null ? byRegion : grouped
    const key = g ?? e.region ?? ''
    if (!bucket.has(key)) bucket.set(key, [])
    bucket.get(key)!.push(e)
  }
  const groups = Object.keys(rollup.groups)
    .filter((g) => grouped.has(g))
    .map((g) => topNode('group', g, grouped.get(g)!))
  const regions = [...byRegion.entries()]
    .map(([r, list]) => topNode('region', r || null, list))
    .sort((a, z) => z.qty - a.qty)
  return [...groups, ...regions]
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
      return [...e.variants, e.businessUnit, e.region, groupOf(rollup, e.businessUnit)].some(
        (v) => v?.toLowerCase().includes(q),
      )
    })
  }, [entries, resolved, rollup, query, unassignedOnly])

  const tree = useMemo(() => buildTree(visible, rollup), [visible, rollup])
  const filtering = query.trim() !== '' || unassignedOnly
  const isOpen = (key: string) => filtering || open.has(key)
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const mergedCount = entries.reduce((n, e) => n + e.variants.length - 1, 0)

  function setRule(level: RollupLevel, key: string, v: string | null) {
    const next: SiteRollup = { ...rollup, [level]: { ...rollup[level] } }
    if (!v || v === INHERIT) delete next[level][key]
    else next[level][key] = v === EXCLUDE ? EXCLUDE : Number(v)
    onChange(next)
  }

  function RuleSelect({
    level,
    ruleKey,
    inherited,
    label,
  }: {
    level: RollupLevel
    ruleKey: string | null
    inherited: RollupTarget | null
    label: string
  }) {
    if (ruleKey === null) {
      return <span className="text-xs text-muted-foreground sm:w-52">No value to assign</span>
    }
    const own = rollup[level][ruleKey]
    const inheritText =
      inherited === null && (level === 'region' || level === 'group')
        ? 'Unassigned'
        : `Inherit: ${targetLabel(inherited)}`
    const items = Object.fromEntries([
      [INHERIT, inheritText],
      ...locations.map((l) => [String(l.id), l.name]),
      [EXCLUDE, 'Exclude'],
    ])
    return (
      <Select
        value={own === undefined ? INHERIT : String(own)}
        items={items}
        onValueChange={(v) => setRule(level, ruleKey, v)}
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
        Quantity over the last {lookbackMonths} months, {fmt(grandTotal)} in total, across{' '}
        {plural(entries.length, 'warehouse')}
        {mergedCount > 0
          ? ` (${plural(mergedCount, 'spelling variant')} folded in, ignoring case, spaces and punctuation)`
          : ''}
        . The most specific rule wins: warehouse, then business unit, then platform group, then
        region.
      </p>

      <PlatformGroupsEditor entries={entries} rollup={rollup} onChange={onChange} />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter warehouses, business units, groups"
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
          {tree.map((node) => {
            const tKey = `${node.kind}:${node.name ?? ''}`
            const level: RollupLevel = node.kind === 'group' ? 'group' : 'region'
            const regions = [...new Set(node.units.map((u) => u.region ?? 'No region'))]
            const fromRegion =
              node.kind === 'group' && regions.length === 1
                ? resolveSite(
                    { region: node.units[0].region, businessUnit: null, site: '' },
                    rollup,
                    'region',
                  ).target
                : null
            return (
              <li key={tKey} className="flex flex-col">
                <div className="flex flex-col gap-2 bg-muted/50 px-3 py-2.5 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={() => toggle(tKey)}
                    aria-expanded={isOpen(tKey)}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn('size-4 shrink-0 transition-transform', isOpen(tKey) && 'rotate-90')}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-semibold">
                      {node.name ?? 'No region'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {node.kind === 'group'
                        ? `Platform group · ${regions.join(', ')}`
                        : 'Region · not in a group'}{' '}
                      · {plural(node.units.length, 'business unit')} ·{' '}
                      {plural(node.count, 'warehouse')}
                    </span>
                    <span className="ml-auto font-mono text-xs tabular-nums">{fmt(node.qty)}</span>
                  </button>
                  <RuleSelect
                    level={level}
                    ruleKey={node.name}
                    inherited={fromRegion}
                    label={`Location for ${node.kind === 'group' ? 'platform group' : 'region'} ${node.name ?? ''}`}
                  />
                </div>

                {isOpen(tKey) && (
                  <ul className="flex flex-col divide-y border-t">
                    {node.units.map((unit) => {
                      const uKey = `${tKey}|${unit.region ?? ''}|b:${unit.name ?? ''}`
                      const fromParent = resolveSite(
                        { region: unit.region, businessUnit: unit.name, site: '' },
                        rollup,
                        'group',
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
                              ruleKey={unit.name}
                              inherited={fromParent}
                              label={`Location for business unit ${unit.name ?? ''}`}
                            />
                          </div>

                          {isOpen(uKey) && (
                            <ul className="flex flex-col divide-y border-t bg-background">
                              {unit.entries.map((e) => {
                                const r = resolved.get(e)!
                                const parent = resolveSite(e, rollup, 'businessUnit').target
                                const ruleKey = siteRuleKey(e.businessUnit, e.site)
                                return (
                                  <li
                                    key={`${uKey}|s:${ruleKey}`}
                                    className="flex flex-col gap-2 py-1.5 pr-3 pl-16 sm:flex-row sm:items-center"
                                  >
                                    <div className="flex min-w-0 flex-1 items-center gap-3">
                                      <div className="flex min-w-0 flex-col">
                                        <span className="font-mono text-xs">
                                          {e.site || '(blank)'}
                                        </span>
                                        {e.variants.length > 1 && (
                                          <span className="truncate text-xs text-muted-foreground">
                                            Also spelled{' '}
                                            {e.variants
                                              .filter((v) => v !== e.site)
                                              .map((v) => `"${v}"`)
                                              .join(', ')}
                                          </span>
                                        )}
                                      </div>
                                      <span className="shrink-0 text-xs text-muted-foreground">
                                        {e.lines.toLocaleString()} lines
                                        {e.lastDate ? ` · last ${e.lastDate}` : ''}
                                      </span>
                                      <span
                                        className={cn(
                                          'ml-auto shrink-0 font-mono text-xs tabular-nums',
                                          e.qty === 0 && 'text-muted-foreground',
                                          r.target === null && e.qty > 0 && 'text-amber-700',
                                        )}
                                      >
                                        {fmt(e.qty)}
                                      </span>
                                    </div>
                                    <RuleSelect
                                      level="site"
                                      ruleKey={ruleKey}
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

function PlatformGroupsEditor({
  entries,
  rollup,
  onChange,
}: {
  entries: SiteHierarchyEntry[]
  rollup: SiteRollup
  onChange: (next: SiteRollup) => void
}) {
  const [newName, setNewName] = useState('')

  const units = useMemo(() => {
    const qty = new Map<string, { name: string; qty: number }>()
    for (const e of entries) {
      if (!e.businessUnit) continue
      const key = normalizeName(e.businessUnit)
      const u = qty.get(key) ?? { name: e.businessUnit, qty: 0 }
      u.qty += e.qty
      qty.set(key, u)
    }
    return [...qty.values()].sort((a, z) => z.qty - a.qty)
  }, [entries])

  const groupNames = Object.keys(rollup.groups)
  const trimmed = newName.trim()
  const duplicate = groupNames.some((g) => g.toLowerCase() === trimmed.toLowerCase())

  function addGroup() {
    if (!trimmed || duplicate) return
    onChange({ ...rollup, groups: { ...rollup.groups, [trimmed]: [] } })
    setNewName('')
  }

  function removeGroup(name: string) {
    const groups = { ...rollup.groups }
    delete groups[name]
    const group = { ...rollup.group }
    delete group[name]
    onChange({ ...rollup, groups, group })
  }

  // A business unit belongs to at most one group, so adding it to one
  // removes it from any other.
  function toggleUnit(groupName: string, unit: string) {
    const key = normalizeName(unit)
    const inGroup = rollup.groups[groupName].some((u) => normalizeName(u) === key)
    const groups = Object.fromEntries(
      Object.entries(rollup.groups).map(([g, list]) => {
        const rest = list.filter((u) => normalizeName(u) !== key)
        return [g, g === groupName && !inGroup ? [...rest, unit] : rest]
      }),
    )
    onChange({ ...rollup, groups })
  }

  return (
    <section aria-labelledby="platform-groups-heading" className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-0.5">
        <h3 id="platform-groups-heading" className="text-sm font-semibold">
          Platform groups
        </h3>
        <p className="text-xs text-muted-foreground">
          Collect business units under one platform entry, then assign the group to a location
          once. A business unit can be in one group.
        </p>
      </div>

      {groupNames.length > 0 && (
        <ul className="flex flex-col gap-3">
          {groupNames.map((g) => {
            const members = new Set(rollup.groups[g].map(normalizeName))
            const missing = rollup.groups[g].filter(
              (u) => !units.some((x) => normalizeName(x.name) === normalizeName(u)),
            )
            return (
              <li key={g} className="flex flex-col gap-2 rounded-md bg-muted/40 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{g}</span>
                  <span className="text-xs text-muted-foreground">
                    {plural(members.size, 'business unit')}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    onClick={() => removeGroup(g)}
                    aria-label={`Delete platform group ${g}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Business units in ${g}`}>
                  {units.map((u) => {
                    const on = members.has(normalizeName(u.name))
                    const elsewhere = !on ? groupOf(rollup, u.name) : null
                    return (
                      <Button
                        key={u.name}
                        type="button"
                        size="sm"
                        variant={on ? 'default' : 'outline'}
                        aria-pressed={on}
                        onClick={() => toggleUnit(g, u.name)}
                        title={elsewhere ? `Currently in ${elsewhere}` : undefined}
                        className={cn('h-7 px-2.5 text-xs', elsewhere && 'text-muted-foreground')}
                      >
                        {u.name}
                        <span className="font-mono tabular-nums opacity-70">{fmt(u.qty)}</span>
                      </Button>
                    )
                  })}
                </div>
                {missing.length > 0 && (
                  <p className="text-xs text-amber-700">
                    Not in the view: {missing.join(', ')}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          addGroup()
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New group, e.g. Southwest"
          aria-label="New platform group name"
          maxLength={100}
          className="sm:max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!trimmed || duplicate}>
          <Plus aria-hidden="true" />
          Add group
        </Button>
        {duplicate && <span className="self-center text-xs text-destructive">That group exists.</span>}
      </form>
    </section>
  )
}
