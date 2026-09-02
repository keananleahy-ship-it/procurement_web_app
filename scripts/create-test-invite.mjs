import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'

const EMAIL = process.argv[2] ?? 'keananleahy@leahywolf.com'
const ROLE = 'viewer'
const INVITE_TTL_DAYS = 7

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')
const normalizeEmail = (e) => e.trim().toLowerCase()

function baseUrl() {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000')
  ).replace(/\/$/, '')
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const email = normalizeEmail(EMAIL)

  // 1. Block if a user already exists (mirrors createInvitation).
  const existing = await pool.query('select id from "user" where email = $1 limit 1', [email])
  if (existing.rows.length > 0) {
    console.log(JSON.stringify({ ok: false, error: 'A user with that email already exists.' }))
    return
  }

  // 2. Pick the admin as the inviter (attribution).
  const admin = await pool.query(
    `select id, name, email from "user" where role = 'admin' order by "createdAt" asc limit 1`,
  )
  const inviter = admin.rows[0] ?? null

  // 3. Supersede any prior pending invite for this email.
  await pool.query(
    `update invitations set status = 'revoked' where email = $1 and status = 'pending'`,
    [email],
  )

  // 4. Create the invite.
  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  await pool.query(
    `insert into invitations
       (id, email, role, "tokenHash", status, "invitedByUserId", "invitedByName", "expiresAt")
     values ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
    [
      randomUUID(),
      email,
      ROLE,
      hashToken(rawToken),
      inviter?.id ?? null,
      inviter?.name ?? inviter?.email ?? null,
      expiresAt,
    ],
  )

  const inviteUrl = `${baseUrl()}/accept-invite?token=${rawToken}`
  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        role: ROLE,
        invitedBy: inviter?.name ?? inviter?.email ?? '(none)',
        expiresAt: expiresAt.toISOString(),
        inviteUrl,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
  })
  .finally(() => pool.end())
