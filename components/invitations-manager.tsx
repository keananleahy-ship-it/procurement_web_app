'use client'

import { useState, useTransition } from 'react'
import {
  createInvitation,
  revokeInvitation,
  resendInvitation,
  type InvitationRow,
} from '@/app/actions/invitations'
import { type Role, ROLES, ROLE_LABELS } from '@/lib/roles-shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Check, Copy, RefreshCw, X } from 'lucide-react'

type LocationOption = { id: number; name: string }

function statusBadge(row: InvitationRow) {
  if (row.status === 'accepted')
    return { label: 'Accepted', cls: 'bg-primary text-primary-foreground' }
  if (row.status === 'revoked')
    return { label: 'Revoked', cls: 'bg-muted text-muted-foreground' }
  if (row.isExpired)
    return { label: 'Expired', cls: 'bg-muted text-muted-foreground' }
  return { label: 'Pending', cls: 'bg-secondary text-secondary-foreground' }
}

function formatDate(d: Date) {
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function InvitationsManager({
  invitations,
  locations,
}: {
  invitations: InvitationRow[]
  locations: LocationOption[]
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  // Selected site for a champion invite, as a string for the Select control.
  const [locationId, setLocationId] = useState<string>('')
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  // The freshly generated link to surface + copy (raw token shown once).
  const [freshLink, setFreshLink] = useState<{ email: string; url: string } | null>(
    null,
  )
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000)
    } catch {
      setError('Could not copy to clipboard. Copy the link manually.')
    }
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setFreshLink(null)
    // A champion must be scoped to a site; block before hitting the server.
    if (role === 'champion' && !locationId) {
      setError('Select a site for this Site Champion.')
      return
    }
    startTransition(async () => {
      const res = await createInvitation({
        email,
        role,
        locationId: role === 'champion' ? Number(locationId) : null,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setFreshLink({ email: res.email, url: res.inviteUrl })
      setEmail('')
      setRole('viewer')
      setLocationId('')
    })
  }

  function handleRevoke(id: string) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      const res = await revokeInvitation(id)
      if (!res.ok) setError(res.error)
      setPendingId(null)
    })
  }

  function handleResend(id: string) {
    setError(null)
    setFreshLink(null)
    setPendingId(id)
    startTransition(async () => {
      const res = await resendInvitation(id)
      if (!res.ok) {
        setError(res.error)
      } else {
        setFreshLink({ email: res.email, url: res.inviteUrl })
      }
      setPendingId(null)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={handleCreate}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-2 sm:min-w-56">
          <Label htmlFor="invite-email">Email address</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="person@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-role">Role</Label>
          <Select
            value={role}
            onValueChange={(v) => {
              setRole(v as Role)
              // Clear any stale site selection when leaving the champion role.
              if (v !== 'champion') setLocationId('')
            }}
          >
            <SelectTrigger id="invite-role" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {role === 'champion' && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-site">Site</Label>
            <Select
              value={locationId}
              onValueChange={(v) => setLocationId(v ?? '')}
            >
              <SelectTrigger id="invite-site" className="w-full sm:w-48">
                <SelectValue placeholder="Select a site" />
              </SelectTrigger>
              <SelectContent>
                {locations.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No sites available
                  </div>
                ) : (
                  locations.map((loc) => (
                    <SelectItem key={loc.id} value={String(loc.id)}>
                      {loc.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Creating...' : 'Create invite'}
        </Button>
      </form>

      {role === 'champion' && (
        <p className="text-xs text-muted-foreground text-balance">
          Site Champions can only access Catalog Validation, scoped to the site
          you choose here. The site is assigned automatically when they accept.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {freshLink && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium text-foreground">
            Invite link for {freshLink.email}
          </p>
          <p className="mt-1 text-xs text-muted-foreground text-balance">
            Copy and share this link securely. For security it is shown only
            once — if you lose it, use Resend to generate a new one.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input readOnly value={freshLink.url} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => copy(freshLink.url, 'fresh')}
            >
              {copiedId === 'fresh' ? (
                <>
                  <Check className="size-4" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-4" /> Copy
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="w-28">Role</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-32">Expires</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No invitations yet. Create one above to invite a teammate.
                </TableCell>
              </TableRow>
            ) : (
              invitations.map((inv) => {
                const badge = statusBadge(inv)
                const rowBusy = isPending && pendingId === inv.id
                const canManage =
                  inv.status === 'pending' && !inv.isExpired
                const canResend =
                  inv.status !== 'accepted'
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium text-foreground">
                      {inv.email}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ROLE_LABELS[inv.role]}
                      {inv.locationName ? (
                        <span className="block text-xs text-muted-foreground">
                          {inv.locationName}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge className={badge.cls}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.status === 'accepted' && inv.acceptedAt
                        ? `Used ${formatDate(inv.acceptedAt)}`
                        : formatDate(inv.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {canResend && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Resend invite for ${inv.email}`}
                            disabled={rowBusy}
                            onClick={() => handleResend(inv.id)}
                            title="Generate a new link"
                          >
                            <RefreshCw className="size-4 text-muted-foreground" />
                          </Button>
                        )}
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Revoke invite for ${inv.email}`}
                            disabled={rowBusy}
                            onClick={() => handleRevoke(inv.id)}
                            title="Revoke invitation"
                          >
                            <X className="size-4 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground text-balance">
        Invites are locked to the email address and expire after 7 days.
        Recipients set their own password when accepting.
      </p>
    </div>
  )
}
