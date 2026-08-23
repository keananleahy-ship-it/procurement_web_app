'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  MapPin,
  CircleCheck,
  TriangleAlert,
  Search,
  Loader2,
  RotateCcw,
  CheckCheck,
  Sparkles,
  Check,
  X,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import {
  VALIDATION_ATTRIBUTE_KEYS,
  vocabularyFor,
  type AttributeKey,
} from '@/lib/attributes'
import {
  setRecordValidated,
  updateValidationAttribute,
  bulkSetValidated,
  suggestAttributesForLocation,
  acceptSuggestion,
  dismissSuggestion,
  type AccessibleLocation,
  type ValidationRecord,
  type ValidationProgress,
} from '@/app/actions/validation'

const NONE = '__none__'

const EDITABLE_COLUMNS: { key: AttributeKey; label: string }[] = [
  { key: 'category', label: 'Category' },
  { key: 'application', label: 'Application' },
  { key: 'subcategory', label: 'Formulation' },
  { key: 'viscosity', label: 'Viscosity' },
  { key: 'packageType', label: 'Packaging' },
]

type Filter = 'all' | 'needs' | 'unvalidated' | 'validated'

export function ValidationView({
  locations,
  activeLocationId,
  records,
  progress,
}: {
  locations: AccessibleLocation[]
  activeLocationId: number | null
  records: ValidationRecord[]
  progress: ValidationProgress
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Separate transition for the AI pass so a long model call shows its own
  // spinner without freezing the per-cell edit affordances.
  const [aiPending, startAi] = useTransition()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  function run(fn: () => Promise<void>) {
    startTransition(async () => {
      await fn()
      router.refresh()
    })
  }

  function runAiSuggest() {
    if (!activeLocationId) return
    setStatus(null)
    startAi(async () => {
      const res = await suggestAttributesForLocation(activeLocationId)
      setStatus(
        res.suggestionsCreated > 0
          ? `AI proposed ${res.suggestionsCreated} value(s) across ${res.productsConsidered} high-volume item(s). Review the highlighted suggestions below — accept or edit each one.`
          : res.productsConsidered === 0
            ? 'No high-volume items here are missing attributes — nothing to suggest.'
            : `Reviewed ${res.productsConsidered} item(s); the AI wasn't confident enough to propose values.`,
      )
      router.refresh()
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => {
      if (
        filter === 'needs' &&
        !((r.hasGaps || r.unitIssue !== null) && !r.validated)
      )
        return false
      if (filter === 'unvalidated' && r.validated) return false
      if (filter === 'validated' && !r.validated) return false
      if (q) {
        const hay =
        `${r.vendorCode ?? ''} ${r.supplier ?? ''} ${r.description}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [records, filter, query])

  const pct =
    progress.total > 0
      ? Math.round((progress.validated / progress.total) * 100)
      : 0

  // No locations assigned to this user.
  if (locations.length === 0) {
    return (
      <div className="p-6">
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <MapPin className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            No locations assigned
          </p>
          <p className="max-w-sm text-sm text-muted-foreground text-pretty">
            You haven&apos;t been assigned as the catalog champion for any
            location yet. Ask an admin to assign your site in User Management.
          </p>
        </Card>
      </div>
    )
  }

  const activeLocation = locations.find((l) => l.id === activeLocationId)
  const remainingIds = filtered.filter((r) => !r.validated).map((r) => r.purchaseId)

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Location switcher + progress */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <Card className="flex flex-col gap-3 p-4 lg:w-80">
          <div className="flex items-center gap-2 text-muted-foreground">
            <MapPin className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">
              Site
            </span>
          </div>
          <Select
            value={activeLocationId ? String(activeLocationId) : null}
            onValueChange={(v) => {
              if (v) router.push(`/validation?location=${v}`)
            }}
            items={Object.fromEntries(
              locations.map((l) => [String(l.id), l.name]),
            )}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>
                  {l.name}
                  {l.region ? ` · ${l.region}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {locations.length > 1 && (
            <p className="text-xs text-muted-foreground">
              You champion {locations.length} sites. Each is validated
              separately.
            </p>
          )}
        </Card>

        <Card className="flex flex-1 flex-col justify-center gap-3 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Validation progress
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {progress.validated} / {progress.total} ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CircleCheck className="size-3.5 text-primary" />
              {progress.validated} validated
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <TriangleAlert className="size-3.5 text-amber-500" />
              {progress.needsAttention} need attention
            </span>
            <span className="text-muted-foreground/70">
              {progress.total - progress.validated} remaining
            </span>
          </div>
        </Card>
      </div>

      {/* Toolbar: filters, search, bulk */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-full border border-border bg-muted p-0.5 text-xs">
          {(
            [
              ['all', 'All'],
              ['needs', 'Needs attention'],
              ['unvalidated', 'Unvalidated'],
              ['validated', 'Validated'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-full px-3 py-1 font-medium transition-colors',
                filter === id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search code or description"
              className="h-8 w-56 pl-8"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={aiPending || pending || !activeLocationId}
            onClick={runAiSuggest}
            title="Fill missing attributes for this site's highest-volume items using AI. Results are staged for your review — nothing is applied automatically."
          >
            {aiPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {aiPending ? 'Analyzing…' : 'Suggest with AI'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || remainingIds.length === 0}
            onClick={() =>
              run(async () => {
                if (!activeLocationId) return
                const res = await bulkSetValidated({
                  locationId: activeLocationId,
                  purchaseIds: remainingIds,
                  validated: true,
                })
                setStatus(`Signed off ${res.count} record(s).`)
              })
            }
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCheck className="size-3.5" />
            )}
            Validate all shown ({remainingIds.length})
          </Button>
        </div>
      </div>

      {status && (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      )}

      {/* Records table */}
      <Card className="overflow-hidden p-0">
        <div className="scrollbar-always-x max-h-[65svh] overflow-x-scroll overflow-y-auto overscroll-contain">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Vendor code</th>
                <th className="px-3 py-2 font-semibold">Vendor</th>
                <th className="px-3 py-2 font-semibold">Description</th>
                {EDITABLE_COLUMNS.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-semibold">
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Volume/yr</th>
                <th className="px-3 py-2 font-semibold">Record ID</th>
                <th className="px-3 py-2 font-semibold">Sign-off</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={EDITABLE_COLUMNS.length + 6}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    {activeLocation
                      ? 'No records match this filter.'
                      : 'Select a location to begin.'}
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.purchaseId}
                  className={cn(
                    'border-b border-border/60 align-top transition-colors',
                    r.validated ? 'bg-primary/[0.03]' : 'hover:bg-muted/30',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {r.vendorCode ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <AttrCell
                      record={r}
                      attrKey="supplier"
                      disabled={pending}
                      onChange={(value) =>
                        run(async () => {
                          if (!activeLocationId) return
                          const res = await updateValidationAttribute({
                            productId: r.productId,
                            locationId: activeLocationId,
                            key: 'supplier',
                            value,
                          })
                          setStatus(
                            res.clearedSignOffs > 0
                              ? `Updated globally · cleared ${res.clearedSignOffs} prior sign-off(s) for re-confirmation.`
                              : 'Updated globally across all sites.',
                          )
                        })
                      }
                      onAccept={() =>
                        run(async () => {
                          if (!activeLocationId) return
                          await acceptSuggestion({
                            productId: r.productId,
                            locationId: activeLocationId,
                            key: 'supplier',
                          })
                          setStatus('Applied AI suggestion globally.')
                        })
                      }
                      onDismiss={() =>
                        run(async () => {
                          if (!activeLocationId) return
                          await dismissSuggestion({
                            productId: r.productId,
                            locationId: activeLocationId,
                            key: 'supplier',
                          })
                        })
                      }
                    />
                  </td>
                  <td className="max-w-[220px] px-3 py-2">
                    <span className="line-clamp-2 font-medium text-foreground">
                      {r.description}
                    </span>
                    {r.brand && (
                      <span className="text-xs text-muted-foreground">
                        {r.brand}
                      </span>
                    )}
                  </td>
                  {EDITABLE_COLUMNS.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <AttrCell
                        record={r}
                        attrKey={c.key}
                        disabled={pending}
                        onChange={(value) =>
                          run(async () => {
                            if (!activeLocationId) return
                            const res = await updateValidationAttribute({
                              productId: r.productId,
                              locationId: activeLocationId,
                              key: c.key,
                              value,
                            })
                            setStatus(
                              res.clearedSignOffs > 0
                                ? `Updated globally · cleared ${res.clearedSignOffs} prior sign-off(s) for re-confirmation.`
                                : 'Updated globally across all sites.',
                            )
                          })
                        }
                        onAccept={() =>
                          run(async () => {
                            if (!activeLocationId) return
                            await acceptSuggestion({
                              productId: r.productId,
                              locationId: activeLocationId,
                              key: c.key,
                            })
                            setStatus('Applied AI suggestion globally.')
                          })
                        }
                        onDismiss={() =>
                          run(async () => {
                            if (!activeLocationId) return
                            await dismissSuggestion({
                              productId: r.productId,
                              locationId: activeLocationId,
                              key: c.key,
                            })
                          })
                        }
                      />
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">
                    <span>{formatNumber(Math.round(r.annualVolume))}</span>
                    {r.unitIssue ? (
                      <span
                        title={r.unitIssue}
                        className="ml-1 inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600"
                      >
                        <TriangleAlert className="size-3" />
                        {r.baseUnit}
                      </span>
                    ) : r.baseUnit ? (
                      ` ${r.baseUnit}`
                    ) : (
                      ''
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground/70">
                    #{r.purchaseId}
                  </td>
                  <td className="px-3 py-2">
                    {r.validated ? (
                      <div className="flex flex-col gap-1">
                        <Badge className="w-fit gap-1 bg-primary/10 text-primary">
                          <CircleCheck className="size-3" />
                          Validated
                        </Badge>
                        {r.validatedByName && (
                          <span className="text-[0.625rem] text-muted-foreground">
                            by {r.validatedByName}
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(async () => {
                              await setRecordValidated(r.purchaseId, false)
                            })
                          }
                          className="flex w-fit items-center gap-1 text-[0.625rem] text-muted-foreground hover:text-foreground"
                        >
                          <RotateCcw className="size-2.5" />
                          Reopen
                        </button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant={r.hasGaps ? 'outline' : 'default'}
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            await setRecordValidated(r.purchaseId, true)
                          })
                        }
                        className="h-7"
                      >
                        Mark validated
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// A single editable catalog attribute cell. Renders a select over the
// controlled vocabulary (or a free-text input for viscosity). Missing values
// are highlighted so gaps stand out. Committing calls the parent's onChange,
// which applies the fix globally to the product.
function AttrCell({
  record,
  attrKey,
  disabled,
  onChange,
  onAccept,
  onDismiss,
}: {
  record: ValidationRecord
  attrKey: AttributeKey
  disabled: boolean
  onChange: (value: string | null) => void
  onAccept: () => void
  onDismiss: () => void
}) {
  const current = (record[attrKey] as string | null) ?? null
  const vocab = vocabularyFor(attrKey, record.category)
  const missing = !current
  // A pending AI suggestion only shows when the value is still missing — once a
  // champion sets a value, the suggestion for that cell is moot.
  const suggestion = missing ? record.suggestions[attrKey] : undefined

  // When there's a pending suggestion for an empty cell, surface it as a
  // reviewable chip (accept / dismiss) sitting above the normal editor, so the
  // champion can accept in one click or still edit/enter their own value.
  if (suggestion) {
    return (
      <div className="flex flex-col gap-1.5">
        <SuggestionChip
          value={suggestion.value}
          confidence={suggestion.confidence}
          rationale={suggestion.rationale}
          disabled={disabled}
          onAccept={onAccept}
          onDismiss={onDismiss}
        />
        {!vocab ? (
          <TextAttr
            value={current}
            disabled={disabled}
            onCommit={onChange}
            widthClass={attrKey === 'supplier' ? 'w-40' : 'w-24'}
          />
        ) : (
          <VocabSelect
            current={current}
            vocab={vocab}
            missing={missing}
            onChange={onChange}
          />
        )}
      </div>
    )
  }

  // Free-text attribute (viscosity, supplier): inline input committing on
  // blur/Enter. Vendor names run longer than viscosity grades, so give them
  // more room.
  if (!vocab) {
    return (
      <TextAttr
        value={current}
        disabled={disabled}
        onCommit={onChange}
        widthClass={attrKey === 'supplier' ? 'w-40' : 'w-24'}
      />
    )
  }

  return (
    <VocabSelect
      current={current}
      vocab={vocab}
      missing={missing}
      onChange={onChange}
    />
  )
}

// The select over a controlled vocabulary, extracted so it can render both
// standalone and beneath a suggestion chip.
function VocabSelect({
  current,
  vocab,
  missing,
  onChange,
}: {
  current: string | null
  vocab: string[]
  missing: boolean
  onChange: (value: string | null) => void
}) {
  // Merge an out-of-vocab current value so it still displays and is selectable.
  const options = current && !vocab.includes(current) ? [current, ...vocab] : vocab
  const items: Record<string, string> = { [NONE]: 'Not set' }
  for (const o of options) items[o] = o

  return (
    <Select
      value={current ?? NONE}
      onValueChange={(v) => {
        const next = !v || v === NONE ? null : v
        if (next !== current) onChange(next)
      }}
      items={items}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          'w-full min-w-[9rem]',
          missing && 'border-amber-500/60 text-amber-600',
        )}
      >
        <SelectValue placeholder="Set…" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">Not set</span>
        </SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// An AI-proposed value for an empty attribute cell, shown for the champion to
// review. Accept applies it (globally, like a manual edit); dismiss discards
// it. The proposal is never applied on its own. The distinct violet styling
// separates "AI suggested, unconfirmed" from the amber "missing" and the
// neutral confirmed states.
function SuggestionChip({
  value,
  confidence,
  rationale,
  disabled,
  onAccept,
  onDismiss,
}: {
  value: string
  confidence: number | null
  rationale: string | null
  disabled: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  const pct = confidence != null ? Math.round(confidence * 100) : null
  const title = rationale
    ? `AI suggestion: ${rationale}${pct != null ? ` (${pct}% confidence)` : ''}`
    : `AI suggestion${pct != null ? ` (${pct}% confidence)` : ''}`
  return (
    <div
      title={title}
      className="flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-1"
    >
      <Sparkles className="size-3 shrink-0 text-violet-500" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-violet-700 dark:text-violet-300">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onAccept}
        aria-label={`Accept suggestion ${value}`}
        className="grid size-5 place-items-center rounded text-violet-600 transition-colors hover:bg-violet-500/20 disabled:opacity-50 dark:text-violet-300"
      >
        <Check className="size-3.5" />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onDismiss}
        aria-label={`Dismiss suggestion ${value}`}
        className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function TextAttr({
  value,
  disabled,
  onCommit,
  widthClass = 'w-24',
}: {
  value: string | null
  disabled: boolean
  onCommit: (value: string | null) => void
  widthClass?: string
}) {
  const [draft, setDraft] = useState(value ?? '')
  const missing = !value
  function commit() {
    const next = draft.trim() ? draft.trim() : null
    if (next !== (value ?? null)) onCommit(next)
  }
  return (
    <Input
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.currentTarget.blur()
        }
      }}
      placeholder="Set…"
      className={cn(
        'h-8',
        widthClass,
        missing && 'border-amber-500/60 placeholder:text-amber-600/70',
      )}
    />
  )
}
