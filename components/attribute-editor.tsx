'use client'

import { useState, useTransition } from 'react'
import { Pencil, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import type { AttributeDef, AttributeKey } from '@/lib/attributes'

export type AttributeValues = Partial<Record<AttributeKey, string | null>>

/**
 * Inline editor for an item's hierarchy attributes. Renders a small pencil
 * trigger; opening it reveals one text field per editable attribute. Saving
 * calls `onSave` (a server action wrapper) for each changed field. Only shown
 * to editors — callers gate on `useCanEdit()`.
 */
export function AttributeEditor({
  editable,
  values,
  onSave,
  label,
}: {
  editable: AttributeDef[]
  values: AttributeValues
  onSave: (key: AttributeKey, value: string | null) => Promise<void>
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AttributeValues>(values)
  const [pending, startTransition] = useTransition()

  function reset() {
    setDraft(values)
  }

  function save() {
    startTransition(async () => {
      for (const def of editable) {
        const next = (draft[def.key] ?? '') as string
        const prev = (values[def.key] ?? '') as string
        if (next.trim() !== prev.trim()) {
          await onSave(def.key, next.trim() ? next.trim() : null)
        }
      }
      setOpen(false)
    })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) reset()
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Edit attributes for ${label}`}
          />
        }
      >
        <Pencil className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium leading-none">Edit attributes</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {label}
            </p>
          </div>
          <div className="flex flex-col gap-2.5">
            {editable.map((def) => (
              <div key={def.key} className="flex flex-col gap-1">
                <Label
                  htmlFor={`attr-${def.key}`}
                  className="text-xs text-muted-foreground"
                >
                  {def.label}
                </Label>
                <Input
                  id={`attr-${def.key}`}
                  value={(draft[def.key] ?? '') as string}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [def.key]: e.target.value }))
                  }
                  className="h-8"
                  placeholder="—"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
