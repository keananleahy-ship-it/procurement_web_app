// Temporary: create a throwaway admin to verify UI, then delete afterward.
import { randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true },
})

const email = 'v0-verify@example.com'
const password = 'verify-password-123'

const ctx = await auth.$context
const hashedPassword = await ctx.password.hash(password)
const now = new Date()

// Clean any prior run first.
await pool.query('DELETE FROM account WHERE "accountId" IN (SELECT id FROM "user" WHERE email = $1)', [email])
await pool.query('DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email = $1)', [email])
await pool.query('DELETE FROM "user" WHERE email = $1', [email])

const createdUser = await ctx.internalAdapter.createUser({
  id: randomUUID(),
  email,
  name: 'V0 Verify',
  emailVerified: true,
  role: 'admin',
  createdAt: now,
  updatedAt: now,
})

await ctx.internalAdapter.linkAccount({
  userId: createdUser.id,
  providerId: 'credential',
  accountId: createdUser.id,
  password: hashedPassword,
  createdAt: now,
  updatedAt: now,
})

console.log('[v0] created temp admin', email, createdUser.id)

// Mint a session by calling the API directly (no Origin header => no origin check).
const res = await auth.api.signInEmail({
  body: { email, password },
  asResponse: true,
})
const setCookie = res.headers.get('set-cookie')
console.log('[v0] set-cookie:', setCookie)

await pool.end()
process.exit(0)
