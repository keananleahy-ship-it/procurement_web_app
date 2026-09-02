import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'

// Usage: node create-test-invite.mjs <email> [role] [siteName]
const EMAIL = process.argv[2]
const ROLE = process.argv[3] ?? 'viewer'
const SITE_NAME = process.argv[4] ?? null
const INVITE_TTL_DAYS = 7

if (!EMAIL) {
  console.error('Usage: node create-test-invite.mjs <email> [role] [siteName]')
  process.exit(1)
}

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

  // 2. Resolve the site for a champion invite.
  let locationId = null
  let locationName = null
  if (ROLE === 'champion') {
    if (!SITE_NAME) {
      console.log(JSON.stringify({ ok: false, error: 'Champion invite requires a site name.' }))
      return
    }
    const loc = await pool.query('select id, name from locations where name = $1 limit 1', [SITE_NAME])
    if (loc.rows.length === 0) {
      console.log(JSON.stringify({ ok: false, error: `No site named "${SITE_NAME}".` }))
      return
    }
    locationId = loc.rows[0].id
    locationName = loc.rows[0].name
  }

  // 3. Pick the admin as the inviter (attribution).
  const admin = await pool.query(
    `select id, name, email from "user" where role = 'admin' order by "createdAt" asc limit 1`,
  )
  const inviter = admin.rows[0] ?? null

  // 4. Supersede any prior pending invite for this email.
  await pool.query(
    `update invitations set status = 'revoked' where email = $1 and status = 'pending'`,
    [email],
  )

  // 5. Create the invite.
  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  await pool.query(
    `insert into invitations
       (id, email, role, "locationId", "tokenHash", status, "invitedByUserId", "invitedByName", "expiresAt")
     values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
    [
      randomUUID(),
      email,
      ROLE,
      locationId,
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
        site: locationName,
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
