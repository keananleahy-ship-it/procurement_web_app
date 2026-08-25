'use client'

import { useMemo, useState, useTransition } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Check, Info, Loader2, Search, Users } from 'lucide-react'
import {
  DEFAULT_SPEC_DIMENSIONS,
  SPEC_DIMENSIONS,
  type SpecDimension,
} from '@/lib/spec-group'
import { computeGapQueue, type GapItem, type GapRow } from '@/lib/spec-gaps'
import { vocabularyFor, type AttributeKey } from '@/lib/attributes'
import { fillGapAttribute } from '@/app/actions/spec-gaps'
import { useCanEdit } from '@/components/role-provider'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 25

const DIMENSION_LABEL = new Map<SpecDimension, string>(
  SPEC_DIMENSIONS.map((d) => [d.key, d.label]),
)

/**
 * One unit of work. The product NAME carries the answer in most cases
 * ("MEGAPLEX XD3 #1" is NLGI 1, "TRANSOIL 50" is SAE 50), so it gets the
 * typographic weight, and the entry field sits directly beside it — the pair a
 * reviewer's eye moves between is the pair that shares a line.
 */
function GapRowCard({
  row,
  canEdit,
  onFilled,
}: {
  row: GapRow
  canEdit: boolean
  onFilled: (id: number, cleared: number) => void
}) {
  const key = row.missing[0]
  const [draft, setDraft] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Peer-observed values first (they are evidence), then any remaining values
  // from the controlled vocabulary, so a reviewer can pick a valid label even
  // when no sibling has used it yet.
  const options = useMemo(() => {
    // Formulation's vocabulary depends on the product's category (hydraulics
    // use additive chemistry, everything else base-oil type), so the row's own
    // category has to scope it or a hydraulic fluid would be offered the wrong
    // list entirely.
    const category =
      row.present.find((p) => p.dimension === 'category')?.value ?? null
    const seen = new Set(row.candidates.map((c) => c.value.toLowerCase()))
    return (vocabularyFor(key as AttributeKey, category) ?? []).filter(
      (v) => !seen.has(v.toLowerCase()),
    )
  }, [row.candidates, row.present, key])

  function submit(value: string) {
    const clean = value.trim()
    if (!clean || pending) return
    setError(null)
    startTransition(async () => {
      try {
        const { clearedSignOffs } = await fillGapAttribute({
          productId: row.id,
          key,
          value: clean,
        })
        onFilled(row.id, clearedSignOffs)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save')
      }
    })
  }

  const listId = `gap-opts-${row.id}`

  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:flex-row md:items-center md:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {row.rivalSuppliers > 0 && (
            <Tooltip>
              <TooltipTrigger aria-label="Cross-supplier impact">
                <Badge
                  variant="secondary"
                  className="gap-1 tabular-nums font-medium"
                >
                  <Users className="size-3" />
                  {row.rivalSuppliers}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {row.rivalSuppliers} other{' '}
                {row.rivalSuppliers === 1 ? 'supplier' : 'suppliers'} already
                offer this spec. Filling this field puts this product into a
                comparable group.
              </TooltipContent>
            </Tooltip>
          )}
          <p className="truncate text-sm font-medium text-foreground">
            {row.name}
          </p>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{row.supplier ?? 'No vendor'}</span>
          {row.present.map((p) => (
            <span key={p.dimension} className="before:mr-2 before:content-['·']">
              {p.value}
            </span>
          ))}
          {row.annualVolume > 0 && (
            <span className="before:mr-2 before:content-['·'] tabular-nums">
              {Math.round(row.annualVolume).toLocaleString()} vol
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 md:w-96">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
            {DIMENSION_LABEL.get(key)}
          </span>
          <Input
            list={listId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Guard the CJK composition case: Enter may be confirming an IME
              // candidate rather than submitting the row.
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                submit(draft)
              }
            }}
            disabled={!canEdit || pending}
            placeholder={canEdit ? 'Type or pick…' : 'View only'}
            aria-label={`${DIMENSION_LABEL.get(key)} for ${row.name}`}
            className="h-8"
          />
          <datalist id={listId}>
            {row.candidates.map((c) => (
              <option key={c.value} value={c.value} />
            ))}
            {options.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <Button
            size="sm"
            onClick={() => submit(draft)}
            disabled={!canEdit || pending || draft.trim() === ''}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            <span className="sr-only">Save</span>
          </Button>
        </div>

        {row.candidates.length > 0 && canEdit && (
          <div className="flex flex-wrap items-center gap-1 pl-24">
            {row.candidates.slice(0, 5).map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => submit(c.value)}
                disabled={pending}
                className="rounded-md border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                title={`${c.count} peer product${c.count === 1 ? '' : 's'} use this`}
              >
                {c.value}
                <span className="ml-1 tabular-nums opacity-60">{c.count}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </li>
  )
}

/** A single number plus its meaning. */
function Stat({
  value,
  label,
  tone = 'default',
}: {
  value: string | number
  label: string
  tone?: 'default' | 'primary'
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums leading-none',
          tone === 'primary' ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function SpecGapsView({ items }: { items: GapItem[] }) {
  const canEdit = useCanEdit()
  const [active, setActive] = useState<SpecDimension[]>(DEFAULT_SPEC_DIMENSIONS)
  const [query, setQuery] = useState('')
  const [impactOnly, setImpactOnly] = useState(true)
  const [shown, setShown] = useState(PAGE_SIZE)
  // Rows filled in this session, hidden immediately so the queue always shows
  // the next piece of work rather than making the reviewer re-find their place.
  const [done, setDone] = useState<Map<number, number>>(new Map())

  const queue = useMemo(() => computeGapQueue(items, active), [items, active])

  const filter = (rows: GapRow[]) => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        !done.has(r.id) &&
        (q === '' ||
          r.name.toLowerCase().includes(q) ||
          (r.supplier ?? '').toLowerCase().includes(q)),
    )
  }

  const oneAway = filter(queue.oneAway)
  const visible = impactOnly
    ? oneAway.filter((r) => r.rivalSuppliers > 0)
    : oneAway
  const multi = filter(queue.multiGap)

  const clearedTotal = [...done.values()].reduce((a, b) => a + b, 0)
  const highImpact = queue.oneAway.filter((r) => r.rivalSuppliers > 0).length

  function onFilled(id: number, cleared: number) {
    setDone((d) => new Map(d).set(id, cleared))
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-6 rounded-lg border border-border bg-card px-5 py-4">
        <Stat value={highImpact} label="Unlock a supplier comparison" tone="primary" />
        <Stat value={queue.oneAway.length} label="One attribute from keyable" />
        <Stat value={queue.multiGap.length} label="Two or more gaps" />
        <Stat value={queue.complete} label="Fully keyed" />
        {done.size > 0 && (
          <Stat value={done.size} label="Filled this session" tone="primary" />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Equivalence key
          </span>
          <Tooltip>
            <TooltipTrigger
              className="text-muted-foreground"
              aria-label="How the equivalence key affects this queue"
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              The queue only asks for attributes the current key needs. Removing
              an attribute here genuinely removes data-entry work, because
              products no longer have to carry it to be comparable.
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {SPEC_DIMENSIONS.map((dimension, index) => {
            const on = active.includes(dimension.key)
            return (
              <div key={dimension.key} className="flex items-center gap-1.5">
                {index > 0 && (
                  <span aria-hidden="true" className="text-sm text-muted-foreground/40">
                    +
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setActive((prev) =>
                        prev.includes(dimension.key)
                          ? prev.filter((d) => d !== dimension.key)
                          : SPEC_DIMENSIONS.map((d) => d.key).filter(
                              (d) =>
                                prev.includes(d) || d === dimension.key,
                            ),
                      )
                    }
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

      {clearedTotal > 0 && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {clearedTotal} purchase{' '}
          {clearedTotal === 1 ? 'record' : 'records'} had sign-off cleared, since
          the corrected attribute changes what those sites previously confirmed.
        </p>
      )}

      <Tabs defaultValue="one-away">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="one-away">
              One away
              <Badge variant="secondary" className="ml-1.5 tabular-nums">
                {oneAway.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="multi">
              Two or more gaps
              <Badge variant="secondary" className="ml-1.5 tabular-nums">
                {multi.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by product or vendor"
              aria-label="Filter the queue"
              className="h-8 w-64 pl-8"
            />
          </div>
        </div>

        <TabsContent value="one-away" className="mt-4">
          <div className="mb-3 flex items-center gap-2">
            <Button
              variant={impactOnly ? 'default' : 'outline'}
              size="sm"
              onClick={() => setImpactOnly((v) => !v)}
              aria-pressed={impactOnly}
            >
              <Users className="size-3.5" />
              Cross-supplier impact only
            </Button>
            <span className="text-xs text-muted-foreground">
              {impactOnly
                ? 'Showing products whose spec another vendor already sells.'
                : 'Showing every one-away product, including specs only one vendor sells.'}
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing left in this view.
            </p>
          ) : (
            <>
              <ul className="rounded-lg border border-border bg-card">
                {visible.slice(0, shown).map((row) => (
                  <GapRowCard
                    key={row.id}
                    row={row}
                    canEdit={canEdit}
                    onFilled={onFilled}
                  />
                ))}
              </ul>
              {visible.length > shown && (
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShown((s) => s + PAGE_SIZE)}
                  >
                    Show {Math.min(PAGE_SIZE, visible.length - shown)} more
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="multi" className="mt-4">
          <p className="mb-3 text-xs text-muted-foreground">
            These need more than one attribute before they can join a spec group,
            so they are lower yield per edit. Fill them from the Catalog
            Validation screen where the full attribute set is editable together.
          </p>
          <ul className="rounded-lg border border-border bg-card">
            {multi.slice(0, shown).map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {row.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.supplier ?? 'No vendor'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {row.missing.map((m) => (
                    <Badge key={m} variant="outline" className="text-xs">
                      {DIMENSION_LABEL.get(m)}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {multi.length > shown && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShown((s) => s + PAGE_SIZE)}
              >
                Show {Math.min(PAGE_SIZE, multi.length - shown)} more
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
