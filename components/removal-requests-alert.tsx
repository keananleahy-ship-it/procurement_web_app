'use client'

import { useState, useTransition } from 'react'
import {
  approveRemovalRequest,
  denyRemovalRequest,
} from '@/app/actions/removal-requests'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useCanAdmin } from '@/components/role-provider'
import { formatDate } from '@/lib/format'
import { Check, X, ShieldAlert } from 'lucide-react'

export type RemovalRequest = {
  id: number
  requestedByName: string | null
  productName: string
  canonicalItemName: string | null
  reason: string
  createdAt: Date | string
}

export function RemovalRequestsAlert({
  requests,
}: {
  requests: RemovalRequest[]
}) {
  const canAdmin = useCanAdmin()
  // Track rows already resolved this session so they disappear immediately.
  const [resolved, setResolved] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [isPending, startTransition] = useTransition()

  // Only admins can act on these, so only admins see the alert.
  if (!canAdmin) return null

  const visible = requests.filter((r) => !resolved.has(r.id))
  if (visible.length === 0) return null

  function resolve(id: number, action: 'approve' | 'deny') {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      try {
        if (action === 'approve') await approveRemovalRequest(id)
        else await denyRemovalRequest(id)
        setResolved((prev) => new Set(prev).add(id))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not resolve request.')
      } finally {
        setPendingId(null)
      }
    })
  }

  return (
    <Card className="border-warning/40 bg-warning/5 p-0">
      <div className="flex items-center gap-2 border-b border-warning/30 px-5 py-4">
        <ShieldAlert className="size-4 text-warning" />
        <h2 className="text-sm font-semibold text-foreground">
          Match removal requests
        </h2>
        <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning">
          {visible.length} pending
        </span>
      </div>

      {error && (
        <p className="px-5 pt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <ul className="divide-y divide-border">
        {visible.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-medium text-foreground">{r.productName}</p>
              {r.canonicalItemName && (
                <p className="text-sm text-muted-foreground">
                  Matched to {r.canonicalItemName}
                </p>
              )}
              <p className="mt-1 text-sm text-pretty text-foreground">
                <span className="text-muted-foreground">Reason: </span>
                {r.reason}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Requested by {r.requestedByName ?? 'a user'} ·{' '}
                {formatDate(r.createdAt)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolve(r.id, 'deny')}
                disabled={isPending && pendingId === r.id}
              >
                <X className="size-4" />
                Deny
              </Button>
              <Button
                size="sm"
                onClick={() => resolve(r.id, 'approve')}
                disabled={isPending && pendingId === r.id}
              >
                <Check className="size-4" />
                Approve removal
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
