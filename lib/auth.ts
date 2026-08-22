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
  // Better Auth rejects any POST whose Origin header isn't in this list with
  // "Invalid origin". The list is a function so we can ALSO trust the host the
  // request was actually served on (see below) — otherwise every hostname the
  // app is reachable from (the *.vercel.app alias, preview deployment URLs, a
  // newly added domain) fails to sign in even though the app loads fine.
  trustedOrigins: (request) => [
    // v0 preview iframes are served from rotating *.vusercontent.net origins,
    // which won't match V0_RUNTIME_URL exactly. Trust the whole domain so the
    // sign-in POST isn't rejected with "Invalid origin".
    'https://*.vusercontent.net',
    // The v0 sandbox dev preview is served from rotating *.vercel.run origins;
    // trust the whole domain so preview sign-in isn't rejected either.
    'https://*.vercel.run',
    // The embedded v0 preview is proxied through *.v0.build, so the browser
    // sends Origin: https://<chat>.v0.build while the request arrives at the
    // sandbox under a different internal host. That mismatch is why sign-in
    // failed inside the preview pane but worked when opened in its own tab.
    'https://*.v0.build',
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
    // Same-origin fallback: trust the exact host this request was served from.
    // This is what makes sign-in work from any device / any URL the app is
    // deployed under (vercel.app alias, preview deployments, future domains).
    // It does NOT weaken CSRF protection: a cross-site attacker's request
    // carries its own Origin (evil.com) while the Host is still ours, so the
    // two don't match and the request is still rejected.
    ...(() => {
      const headers = request?.headers
      if (!headers) return []
      const host = headers.get('x-forwarded-host') ?? headers.get('host')
      if (!host) return []
      // Both schemes: behind Vercel's proxy the forwarded proto can disagree
      // with the browser's Origin (http hop internally, https externally).
      // The host is what matters for the same-origin check.
      return [`https://${host}`, `http://${host}`]
    })(),
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
