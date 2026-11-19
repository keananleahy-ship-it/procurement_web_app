'use client'

import type { Facet } from '@/app/actions/snowflake-source'
import type { PullOptions } from '@/lib/snowflake-source'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const UNMAPPED = '__unmapped'

export type PullFacets = {
  categories: Facet[]
  vendors: Facet[]
  appVendors: { id: number; name: string }[]
}

const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function SnowflakePullFilters({
  facets,
  options,
  onChange,
}: {
  facets: PullFacets
  options: PullOptions
  onChange: (next: PullOptions) => void
}) {
  const excluded = new Set(options.excludedCategories)
  const vendorItems = Object.fromEntries([
    [UNMAPPED, 'Not mapped'],
    ...facets.appVendors.map((v) => [String(v.id), v.name]),
  ])

  const toggleCategory = (key: string, include: boolean) => {
    const next = new Set(excluded)
    if (include) next.delete(key)
    else next.add(key)
    onChange({ ...options, excludedCategories: [...next].sort() })
  }

  const setVendor = (key: string, value: string | null) => {
    const vendorMap = { ...options.vendorMap }
    if (!value || value === UNMAPPED) delete vendorMap[key]
    else vendorMap[key] = Number(value)
    onChange({ ...options, vendorMap })
  }

  const mappedCount = facets.vendors.filter((v) => options.vendorMap[v.key]).length

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted-foreground">
          Unchecked categories are left out of pulls.{' '}
          {excluded.size > 0 && `${excluded.size} excluded.`}
        </legend>
        {facets.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Map the product category column to filter by category.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col overflow-y-auto rounded-md border">
            {facets.categories.map((c) => {
              const id = `sf-cat-${c.key}`
              const included = !excluded.has(c.key)
              return (
                <li
                  key={c.key}
                  className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={included}
                    onChange={(e) => toggleCategory(c.key, e.target.checked)}
                  />
                  <label
                    htmlFor={id}
                    className={
                      included ? 'flex-1 text-sm' : 'flex-1 text-sm text-muted-foreground line-through'
                    }
                  >
                    {c.label}
                  </label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {qtyFmt.format(c.qty)} qty · {qtyFmt.format(c.lines)} lines
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted-foreground">
          Map Snowflake vendors to app vendors so part numbers match against that
          vendor&apos;s price sheets. {mappedCount} of {facets.vendors.length} mapped.
        </legend>
        {facets.vendors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Map the vendor column to match part numbers by vendor.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col overflow-y-auto rounded-md border">
            {facets.vendors.map((v) => {
              const value = options.vendorMap[v.key]
              return (
                <li
                  key={v.key}
                  className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{v.label}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {qtyFmt.format(v.qty)} qty · {qtyFmt.format(v.lines)} lines
                    </span>
                  </div>
                  {value ? <Badge variant="secondary">Mapped</Badge> : null}
                  <Select
                    value={value ? String(value) : UNMAPPED}
                    items={vendorItems}
                    onValueChange={(next) => setVendor(v.key, next)}
                  >
                    <SelectTrigger aria-label={`App vendor for ${v.label}`} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED}>Not mapped</SelectItem>
                      {facets.appVendors.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>
    </div>
  )
}
