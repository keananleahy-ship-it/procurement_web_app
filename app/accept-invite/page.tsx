import Link from 'next/link'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { validateInvitationToken } from '@/app/actions/invitations'
import { ROLE_LABELS } from '@/lib/roles-shared'
import { AcceptInviteForm } from '@/components/accept-invite-form'

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  // Already signed in? No reason to be here.
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/')

  const { token } = await searchParams
  const result = await validateInvitationToken(token ?? '')

  if (!result.ok) {
    return (
      <main className="min-h-svh bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-sm p-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Invitation unavailable
          </h1>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
          <Link
            href="/sign-in"
            className="text-foreground font-medium underline-offset-4 hover:underline text-sm mt-6 inline-block"
          >
            Go to sign in
          </Link>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Accept your invitation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {result.invitedByName
              ? `${result.invitedByName} invited you`
              : 'You have been invited'}{' '}
            to join as a{' '}
            <span className="font-medium text-foreground">
              {ROLE_LABELS[result.role]}
            </span>
            . Set a password to finish creating your account.
          </p>
        </div>
        <AcceptInviteForm token={token ?? ''} email={result.email} />
      </Card>
    </main>
  )
}
