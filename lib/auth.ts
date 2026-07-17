import { betterAuth } from 'better-auth'
import { pool } from '@/lib/db'

export const auth = betterAuth({
  database: pool,
  // Access is invite-only. Public sign-up is disabled so accounts can only be
  // created by accepting a valid admin-issued invitation (see
  // app/actions/invitations.ts, which creates users through the internal
  // adapter with the pre-assigned role). The old "first user becomes admin"
  // create-hook was removed: an existing admin is already in place, and with
  // invite-based creation that hook could wrongly promote an invited viewer.
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.V0_RUNTIME_URL),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // Invite-only: block the public sign-up endpoint. New accounts are created
    // exclusively via the accept-invite flow (internal adapter), not this API.
    disableSignUp: true,
  },
  trustedOrigins: [
    // v0 preview iframes are served from rotating *.vusercontent.net origins,
    // which won't match V0_RUNTIME_URL exactly. Trust the whole domain so the
    // sign-in POST isn't rejected with "Invalid origin".
    'https://*.vusercontent.net',
    // Production custom domain. Without these, sign-in requests coming from the
    // custom domain are rejected as "Invalid origin" once DNS is pointed here.
    'https://leahywolf.net',
    'https://www.leahywolf.net',
    ...(process.env.V0_RUNTIME_URL ? [process.env.V0_RUNTIME_URL] : []),
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    ...(process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]
      : []),
    ...(process.env.NODE_ENV === 'development'
      ? ['http://localhost:3000', 'http://127.0.0.1:3000']
      : []),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  ...(process.env.NODE_ENV === 'development'
    ? {
        advanced: {
          // In dev (v0 preview iframe), force cross-site cookies so the
          // session cookie is stored by the browser.
          defaultCookieAttributes: {
            sameSite: 'none' as const,
            secure: true,
          },
        },
      }
    : {}),
})
