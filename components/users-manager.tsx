'use client'

import { useState, useTransition } from 'react'
import { deleteUser, setUserRole, type ManagedUser } from '@/app/actions/users'
import {
  type Role,
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
} from '@/lib/roles-shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Trash2 } from 'lucide-react'

function roleBadgeClass(role: Role): string {
  switch (role) {
    case 'admin':
      return 'bg-primary text-primary-foreground'
    case 'uploader':
      return 'bg-secondary text-secondary-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function UsersManager({
  users,
  currentUserId,
}: {
  users: ManagedUser[]
  currentUserId: string
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const adminCount = users.filter((u) => u.role === 'admin').length

  function run(id: string, fn: () => Promise<unknown>) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setPendingId(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {ROLES.map((role) => (
          <div
            key={role}
            className="rounded-lg border border-border bg-card p-4"
          >
            <p className="text-sm font-semibold text-foreground">
              {ROLE_LABELS[role]}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {ROLE_DESCRIPTIONS[role]}
            </p>
          </div>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="w-44">Role</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const isSelf = u.id === currentUserId
              const isLastAdmin = u.role === 'admin' && adminCount <= 1
              const rowBusy = isPending && pendingId === u.id
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-medium text-foreground">
                    <span className="flex items-center gap-2">
                      {u.name}
                      {isSelf && (
                        <Badge className="bg-muted text-muted-foreground">
                          You
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={u.role}
                      onValueChange={(value) => {
                        if (!value || value === u.role) return
                        run(u.id, () => setUserRole(u.id, value as Role))
                      }}
                      disabled={rowBusy}
                    >
                      <SelectTrigger className="w-40" aria-label={`Role for ${u.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem
                            key={role}
                            value={role}
                            disabled={
                              isLastAdmin && role !== 'admin'
                            }
                          >
                            {ROLE_LABELS[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${u.name}`}
                      disabled={rowBusy || isSelf || isLastAdmin}
                      onClick={() => {
                        if (
                          confirm(
                            `Remove ${u.name}? They will lose access to the workspace.`,
                          )
                        ) {
                          run(u.id, () => deleteUser(u.id))
                        }
                      }}
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        New sign-ups join as viewers. Promote them to uploader or admin here.
      </p>
    </div>
  )
}
