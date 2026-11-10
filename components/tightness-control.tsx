'use client'

import { useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  decodeTightness,
  encodeTightness,
  PRESET_LABELS,
  PRESETS,
  presetFor,
  TRAITS,
  type PresetId,
  type Tightness,
  type TraitLevel,
} from '@/lib/traits'

const LEVEL_LABELS: Record<TraitLevel, string> = {
  exact: 'Must match',
  close: 'Close enough',
  ignore: 'Ignore',
}

// Reads and writes the comparison tightness in the `t` search param, so the
// server page re-groups and the view is shareable.
export function TightnessControl() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const tightness = decodeTightness(params.get('t'))
  const active = presetFor(tightness)

  function apply(next: Tightness) {
    const sp = new URLSearchParams(params.toString())
    sp.set('t', encodeTightness(next))
    startTransition(() => router.replace(`${pathname}?${sp.toString()}`))
  }

  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Comparison tightness"
        className="inline-flex rounded-md border border-border bg-muted p-0.5"
      >
        {(Object.keys(PRESETS) as PresetId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active === id}
            onClick={() => apply(PRESETS[id])}
            className={cn(
              'rounded px-3 py-1 text-sm font-medium transition-colors',
              active === id
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {PRESET_LABELS[id]}
          </button>
        ))}
      </div>
      <Popover>
        <PopoverTrigger
          render={<Button variant="outline" size="sm" className="gap-1.5" />}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          {active ? 'Dials' : 'Custom'}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium leading-none">
                How tight is comparable?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Products are grouped only when every dialed trait agrees.
              </p>
            </div>
            {TRAITS.map((def) => (
              <div key={def.key} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  {def.label}
                </span>
                <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
                  {def.levels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={tightness[def.key] === level}
                      title={level === 'close' ? def.closeHint : undefined}
                      onClick={() => apply({ ...tightness, [def.key]: level })}
                      className={cn(
                        'flex-1 rounded px-2 py-0.5 text-xs transition-colors',
                        tightness[def.key] === level
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {LEVEL_LABELS[level]}
                    </button>
                  ))}
                </div>
                {tightness[def.key] === 'close' && def.closeHint && (
                  <span className="text-[11px] text-muted-foreground">
                    {def.closeHint}
                  </span>
                )}
              </div>
            ))}
            <label className="flex items-start gap-2 border-t border-border pt-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={tightness.missing === 'wildcard'}
                onChange={(e) =>
                  apply({
                    ...tightness,
                    missing: e.target.checked ? 'wildcard' : 'no-match',
                  })
                }
              />
              <span>
                Group products missing a required trait together
                <span className="block text-muted-foreground">
                  Off: they are listed under Needs characteristics instead.
                </span>
              </span>
            </label>
          </div>
        </PopoverContent>
      </Popover>
      {pending && (
        <Loader2
          className="size-4 animate-spin text-muted-foreground"
          aria-label="Regrouping"
        />
      )}
    </div>
  )
}
