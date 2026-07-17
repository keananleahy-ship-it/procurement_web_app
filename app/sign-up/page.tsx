import { redirect } from 'next/navigation'

// Access is invite-only. Public sign-up has been removed — anyone hitting this
// route is sent to sign in. New accounts are created only via a valid invite
// link (/accept-invite).
export default function SignUpPage() {
  redirect('/sign-in')
}
