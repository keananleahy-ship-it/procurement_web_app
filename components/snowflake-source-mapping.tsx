'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { ArrowRight, DatabaseZap, RefreshCw } from 'lucide-react'
import {
  type PullSummary,
  type SiteHierarchyEntry,
  type SourceMapping,
  loadSiteHierarchy,
  loadSourceColumns,
  pullSnowflakeVolumes,
  saveSourceMapping,
} from '@/app/actions/snowflake-source'
import {
  SOURCE_FIELDS,
  type ColumnMap,
  type SiteRollup,
  emptyRollup,
  rollupLocationIds,
} from '@/lib/snowflake-source'
import { SnowflakeSiteRollup } from '@/components/snowflake-site-rollup'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const NONE = '__none'

type Notice = { ok: boolean; text: string } | null

export function SnowflakeSourceMapping({
  mapping,
  locations,
  connected,
}: {
  mapping: SourceMapping | null
  locations: { id: number; name: string }[]
  connected: boolean
}) {
  const [table, setTable] = useState(mapping?.sourceTable ?? '')
  const [columns, setColumns] = useState<string[]>(
    () => Object.values(mapping?.columnMap ?? {}).filter(Boolean) as string[],
  )
  const [columnMap, setColumnMap] = useState<ColumnMap>(mapping?.columnMap ?? {})
  const [hierarchy, setHierarchy] = useState<SiteHierarchyEntry[]>([])
  const [rollup, setRollup] = useState<SiteRollup>(mapping?.siteRollup ?? emptyRollup())
  const [lookback, setLookback] = useState(String(mapping?.lookbackMonths ?? 12))
  const [notice, setNotice] = useState<Notice>(null)
  const [pulled, setPulled] = useState<{ imports: PullSummary[]; skipped: string[] } | null>(
    null,
  )
  const [pending, startTransition] = useTransition()

  const columnItems = Object.fromEntries([[NONE, 'Not mapped'], ...columns.map((c) => [c, c])])

  function run(task: () => Promise<void>) {
    setNotice(null)
    startTransition(task)
  }

  const loadColumns = () =>
    run(async () => {
      const res = await loadSourceColumns(table)
      if (!res.ok) return setNotice({ ok: false, text: res.message })
      setColumns(res.columns)
      setColumnMap((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([, c]) => res.columns.includes(c!))),
      )
      setNotice({ ok: true, text: `Found ${res.columns.length} columns.` })
    })

  const loadSites = () =>
    run(async () => {
      const res = await loadSiteHierarchy({
        table,
        columnMap,
        lookbackMonths: Number(lookback),
      })
      if (!res.ok) return setNotice({ ok: false, text: res.message })
      setHierarchy(res.entries)
      setNotice({ ok: true, text: `Found ${res.entries.length} warehouses.` })
    })

  const save = () =>
    run(async () => {
      const res = await saveSourceMapping({
        sourceTable: table,
        columnMap,
        siteRollup: rollup,
        lookbackMonths: Number(lookback),
      })
      setNotice({ ok: res.ok, text: res.message })
    })

  const pull = () =>
    run(async () => {
      const res = await pullSnowflakeVolumes()
      if (!res.ok) return setNotice({ ok: false, text: res.message })
      setPulled({ imports: res.imports, skipped: res.skipped })
    })

  const mappedSites = rollupLocationIds(rollup).length
  const canLoadSites = Boolean(columnMap.site && columnMap.quantity && columnMap.date)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseZap className="size-5" aria-hidden="true" />
          Purchasing data source
        </CardTitle>
        <CardDescription>
          Point the app at the Snowflake view that holds purchase lines, match its columns,
          and pair each site with a location. Pulls are staged for review; spreadsheet
          volumes at a location are replaced only when you apply its pull.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        {!connected && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Save a working connection above before mapping a view.
          </p>
        )}

        <section className="flex flex-col gap-3" aria-labelledby="sf-view-heading">
          <h3 id="sf-view-heading" className="text-sm font-medium">
            1. View
          </h3>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="sf-source-table">Database.Schema.View</Label>
              <Input
                id="sf-source-table"
                value={table}
                onChange={(e) => setTable(e.target.value)}
                placeholder="PURCHASING.REPORTING.LUBRICANT_PURCHASES"
                className="font-mono"
                disabled={!connected}
              />
            </div>
            <Button
              variant="outline"
              onClick={loadColumns}
              disabled={!connected || pending || !table.trim()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Load columns
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="sf-cols-heading">
          <h3 id="sf-cols-heading" className="text-sm font-medium">
            2. Columns
          </h3>
          {columns.length === 0 ? (
            <p className="text-sm text-muted-foreground">Load the view to choose columns.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {SOURCE_FIELDS.map((f) => (
                <div key={f.key} className="flex flex-col gap-2">
                  <Label>
                    {f.label}
                    {f.required ? (
                      <span className="text-destructive" aria-hidden="true">
                        {' *'}
                      </span>
                    ) : (
                      <span className="font-normal text-muted-foreground"> (optional)</span>
                    )}
                  </Label>
                  <Select
                    value={columnMap[f.key] ?? NONE}
                    items={columnItems}
                    onValueChange={(v) =>
                      setColumnMap((prev) => {
                        const next = { ...prev }
                        if (!v || v === NONE) delete next[f.key]
                        else next[f.key] = v
                        return next
                      })
                    }
                  >
                    <SelectTrigger aria-label={f.label} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not mapped</SelectItem>
                      {columns.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="sf-sites-heading">
          <div className="flex items-center justify-between gap-4">
            <h3 id="sf-sites-heading" className="text-sm font-medium">
              3. Location rollup
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={loadSites}
              disabled={!connected || pending || !canLoadSites}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Load warehouses
            </Button>
          </div>
          {hierarchy.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {canLoadSites
                ? 'Load the warehouses in the view to roll them up to locations.'
                : 'Map the warehouse, quantity, and date columns first. Map business unit and region to assign whole groups at once.'}
              {mappedSites > 0 && ` ${mappedSites} location(s) already have saved rules.`}
            </p>
          ) : (
            <SnowflakeSiteRollup
              entries={hierarchy}
              rollup={rollup}
              onChange={setRollup}
              locations={locations}
              lookbackMonths={Number(lookback) || 12}
            />
          )}
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="sf-window-heading">
          <h3 id="sf-window-heading" className="text-sm font-medium">
            4. Window
          </h3>
          <div className="flex max-w-48 flex-col gap-2">
            <Label htmlFor="sf-lookback">Months of purchases</Label>
            <Input
              id="sf-lookback"
              type="number"
              min={1}
              max={36}
              value={lookback}
              onChange={(e) => setLookback(e.target.value)}
              disabled={!connected}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Quantities are summed over this window and scaled to an annual volume.
          </p>
        </section>

        <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center">
          <Button variant="outline" onClick={save} disabled={!connected || pending}>
            Save mapping
          </Button>
          <Button onClick={pull} disabled={!connected || pending || mappedSites === 0}>
            <DatabaseZap className="size-4" aria-hidden="true" />
            Pull purchasing data
          </Button>
          {mapping?.lastPulledAt && (
            <span className="text-sm text-muted-foreground">
              Last pulled {new Date(mapping.lastPulledAt).toLocaleString()}
            </span>
          )}
        </div>

        <div aria-live="polite" className="flex flex-col gap-3">
          {notice && (
            <p
              className={cn(
                'text-sm',
                notice.ok ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {notice.text}
            </p>
          )}
          {pulled && (
            <div className="flex flex-col gap-2 rounded-md border p-4">
              <p className="text-sm font-medium">
                {pulled.imports.length === 0
                  ? 'No purchase lines found for the mapped sites.'
                  : 'Staged for review. Nothing changes until you apply each location.'}
              </p>
              <ul className="flex flex-col gap-1">
                {pulled.imports.map((imp) => (
                  <li key={imp.volumeImportId}>
                    <Link
                      href={`/volumes/${imp.volumeImportId}`}
                      className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
                    >
                      {imp.locationName}: {imp.rowCount} lines, {imp.coverage}
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
              {pulled.skipped.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  No data for: {pulled.skipped.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
