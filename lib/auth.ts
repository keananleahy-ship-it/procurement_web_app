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
    // Same-origin fallback: trust the host this request was served on, so
    // sign-in works from whatever Vercel-generated URL the app is reached at
    // (deployment URLs, aliases) without enumerating each one here.
    //
    // The host is only honoured when it belongs to a domain we control. The
    // Host / X-Forwarded-Host headers are attacker-controllable when a request
    // doesn't pass through Vercel's edge, so trusting them verbatim would let a
    // cross-site attacker send Origin: evil.com together with
    // X-Forwarded-Host: evil.com and defeat the CSRF origin check entirely.
    // Restricting to these suffixes keeps that door shut. A brand new custom
    // domain must be added to the explicit list above.
    ...(() => {
      const headers = request?.headers
      if (!headers) return []
      const host = headers.get('x-forwarded-host') ?? headers.get('host')
      if (!host) return []
      const hostname = host.split(':')[0].toLowerCase()
      const allowed = [
        '.vercel.app',
        '.vercel.run',
        '.v0.build',
        '.vusercontent.net',
        'leahywolf.net',
      ]
      const ok = allowed.some(
        (s) =>
          s.startsWith('.')
            ? hostname.endsWith(s)
            : hostname === s || hostname.endsWith(`.${s}`),
      )
      if (!ok) return []
      // Both schemes: behind Vercel's proxy the forwarded proto can disagree
      // with the browser's Origin (http hop internally, https externally).
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
