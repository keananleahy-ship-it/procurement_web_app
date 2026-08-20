'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Check, Loader2 } from 'lucide-react'
import {
  assignUserLocation,
  unassignUserLocation,
  type LocationOption,
  type UserAssignments,
  type ManagedUser,
} from '@/app/actions/users'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Admin UI for assigning site-champion locations. Each non-admin member gets a
// row of toggleable location chips; admins implicitly own every site so they
// are shown as such and are not individually assignable.
export function SiteAssignmentsManager({
  users,
  locations,
  assignments,
}: {
  users: ManagedUser[]
  locations: LocationOption[]
  assignments: UserAssignments[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const assignedByUser = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const a of assignments) map.set(a.userId, new Set(a.locationIds))
    return map
  }, [assignments])

  function toggle(userId: string, locationId: number, on: boolean) {
    const key = `${userId}:${locationId}`
    setError(null)
    setBusyKey(key)
    startTransition(async () => {
      try {
        if (on) await assignUserLocation(userId, locationId)
        else await unassignUserLocation(userId, locationId)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setBusyKey(null)
      }
    })
  }

  if (locations.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Add locations first — champions are assigned per location.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {users.map((u) => {
          const isAdmin = u.role === 'admin'
          const assigned = assignedByUser.get(u.id) ?? new Set<number>()
          return (
            <div
              key={u.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {u.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {u.email}
                </p>
              </div>
              {isAdmin ? (
                <Badge className="w-fit gap-1 bg-primary/10 text-primary">
                  <MapPin className="size-3" />
                  All sites (admin)
                </Badge>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {locations.map((l) => {
                    const on = assigned.has(l.id)
                    const key = `${u.id}:${l.id}`
                    const busy = isPending && busyKey === key
                    return (
                      <button
                        key={l.id}
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(u.id, l.id, !on)}
                        aria-pressed={on}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
                        )}
                      >
                        {busy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : on ? (
                          <Check className="size-3" />
                        ) : (
                          <MapPin className="size-3" />
                        )}
                        {l.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Champions can review, correct, and sign off catalog data for their
        assigned sites only. Attribute corrections apply to the shared product
        across all sites; the per-site purchase record ID is always preserved.
      </p>
    </div>
  )
}
