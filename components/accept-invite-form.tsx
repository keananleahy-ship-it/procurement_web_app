'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { acceptInvitation } from '@/app/actions/invitations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function AcceptInviteForm({
  token,
  email,
}: {
  token: string
  email: string
}) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    // 1) Create the account server-side (public sign-up is disabled).
    const res = await acceptInvitation({ token, password, name })
    if (!res.ok) {
      setLoading(false)
      setError(res.error)
      return
    }

    // 2) Sign in with the credentials the user just set.
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    })
    if (signInError) {
      setLoading(false)
      // Account exists now; send them to sign in manually as a fallback.
      setError(
        'Your account was created, but automatic sign-in failed. Please sign in.',
      )
      return
    }

    // Hard navigation so the session cookie is committed before the RSC load.
    window.location.assign('/')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          readOnly
          disabled
          aria-describedby="email-locked-hint"
          autoComplete="email"
        />
        <p id="email-locked-hint" className="text-xs text-muted-foreground">
          This invitation is locked to this email address.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Your name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Create a password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <p className="text-xs text-muted-foreground">At least 8 characters.</p>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Creating account...' : 'Accept invitation'}
      </Button>
    </form>
  )
}
