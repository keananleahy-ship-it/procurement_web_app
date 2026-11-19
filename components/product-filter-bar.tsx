'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Filter, Plus, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type FilterDef = { key: string; label: string; emptyLabel: string }
export type ActiveFilter = { key: string; values: string[] }

type Props<Row> = {
  defs: FilterDef[]
  filters: ActiveFilter[]
  onChange: (next: ActiveFilter[]) => void
  rows: Row[]
  valueOf: (row: Row, key: string) => string | null
  // Rows matching every filter except the given one; used for option counts.
  rowsExcept: (key: string) => Row[]
}

export function ProductFilterBar<Row>({
  defs,
  filters,
  onChange,
  valueOf,
  rowsExcept,
}: Props<Row>) {
  const remaining = defs.filter((d) => !filters.some((f) => f.key === d.key))

  function update(key: string, values: string[]) {
    onChange(filters.map((f) => (f.key === key ? { ...f, values } : f)))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Filter className="size-4" aria-hidden="true" />
        Filter by
      </span>

      {filters.length === 0 && (
        <span className="text-sm text-muted-foreground">
          No attributes selected — showing every product
        </span>
      )}

      {filters.map((f) => {
        const def = defs.find((d) => d.key === f.key)
        if (!def) return null
        return (
          <FilterChip
            key={f.key}
            def={def}
            selected={f.values}
            rows={rowsExcept(f.key)}
            valueOf={valueOf}
            onSelect={(values) => update(f.key, values)}
            onRemove={() => onChange(filters.filter((x) => x.key !== f.key))}
          />
        )
      })}

      {remaining.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className="h-7 gap-1" />}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add attribute
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {remaining.map((d) => (
              <DropdownMenuItem
                key={d.key}
                onClick={() => onChange([...filters, { key: d.key, values: [] }])}
              >
                {d.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {filters.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-muted-foreground"
          onClick={() => onChange([])}
        >
          Clear all
        </Button>
      )}
    </div>
  )
}

function FilterChip<Row>({
  def,
  selected,
  rows,
  valueOf,
  onSelect,
  onRemove,
}: {
  def: FilterDef
  selected: string[]
  rows: Row[]
  valueOf: (row: Row, key: string) => string | null
  onSelect: (values: string[]) => void
  onRemove: () => void
}) {
  const [search, setSearch] = useState('')

  const options = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const v = valueOf(r, def.key) ?? def.emptyLabel
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    for (const s of selected) if (!counts.has(s)) counts.set(s, 0)
    return Array.from(counts.entries()).sort(([a], [b]) => {
      if (a === def.emptyLabel) return 1
      if (b === def.emptyLabel) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
  }, [rows, valueOf, def, selected])

  const q = search.trim().toLowerCase()
  const visible = q ? options.filter(([v]) => v.toLowerCase().includes(q)) : options

  function toggle(value: string) {
    onSelect(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    )
  }

  const summary =
    selected.length === 0
      ? 'Any'
      : selected.length <= 2
        ? selected.join(', ')
        : `${selected.length} selected`

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border text-sm',
        selected.length
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-muted/60',
      )}
    >
      <Popover onOpenChange={(o) => !o && setSearch('')}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="inline-flex max-w-72 items-center gap-1.5 rounded-l-md py-0.5 pl-2 pr-1 hover:bg-background/60"
            />
          }
        >
          <span className="font-medium">{def.label}:</span>
          <span
            className={cn(
              'truncate',
              selected.length ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {summary}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${def.label.toLowerCase()}`}
                aria-label={`Search ${def.label} values`}
                className="h-8 pl-8"
              />
            </div>
          </div>
          <ul className="max-h-72 overflow-y-auto p-1" aria-label={`${def.label} values`}>
            {visible.length === 0 && (
              <li className="px-2 py-3 text-center text-sm text-muted-foreground">
                No values
              </li>
            )}
            {visible.map(([value, count]) => (
              <li key={value}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={selected.includes(value)}
                    onChange={() => toggle(value)}
                    className="size-4 accent-primary"
                  />
                  <span
                    className={cn(
                      'flex-1 truncate',
                      value === def.emptyLabel && 'italic text-muted-foreground',
                    )}
                  >
                    {value}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {selected.length > 0 && (
            <div className="border-t border-border p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => onSelect([])}
              >
                Clear selection
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${def.label} filter`}
        className="rounded-r-md p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}
