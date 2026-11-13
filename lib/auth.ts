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
    // Production custom domain. Without these, sign-in requests coming from the
    // custom domain are rejected as "Invalid origin" once DNS is pointed here.
    'https://leahywolf.net',
    'https://www.leahywolf.net',
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    // Preview deployments are also reachable at a stable per-branch alias
    // (…-git-<branch>-….vercel.app), which differs from VERCEL_URL. Without it,
    // signing in from the branch preview address fails with "Invalid origin".
    ...(process.env.VERCEL_BRANCH_URL
      ? [`https://${process.env.VERCEL_BRANCH_URL}`]
      : []),
    ...(process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]
      : []),
    ...(process.env.NODE_ENV === 'development'
      ? [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          ...[
            process.env.V0_RUNTIME_URL,
            process.env.V0_DEV_APP_URL,
            process.env.V0_BUILD_URL,
            process.env.V0_SANDBOX_URL,
          ].filter((url): url is string => Boolean(url)),
          // v0 preview iframes can also be served from rotating hostnames on
          // these domains. Dev-only, so deployed builds never trust them.
          'https://*.vusercontent.net',
          'https://*.vercel.run',
        ]
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
