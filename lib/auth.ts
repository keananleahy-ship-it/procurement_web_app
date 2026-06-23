import { betterAuth } from 'better-auth'
import { eq, sql } from 'drizzle-orm'
import { pool, db } from '@/lib/db'
import { user } from '@/lib/db/schema'

export const auth = betterAuth({
  database: pool,
  databaseHooks: {
    user: {
      create: {
        // After a new account is created, promote it to admin if no admin
        // exists yet — making the very first registered user the admin.
        after: async (createdUser) => {
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(user)
            .where(eq(user.role, 'admin'))
          if (count === 0) {
            await db
              .update(user)
              .set({ role: 'admin' })
              .where(eq(user.id, createdUser.id))
          }
        },
      },
    },
  },
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
  },
  trustedOrigins: [
    // v0 preview iframes are served from rotating *.vusercontent.net origins,
    // which won't match V0_RUNTIME_URL exactly. Trust the whole domain so the
    // sign-in POST isn't rejected with "Invalid origin".
    'https://*.vusercontent.net',
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
