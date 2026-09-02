import { Pool } from 'pg'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node scripts/inspect-champion.mjs <email>')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const { rows: users } = await pool.query(
  `select id, name, email, role, "createdAt" from "user" where lower(email) = lower($1)`,
  [email],
)

if (users.length === 0) {
  console.log(`No user found for ${email}`)
} else {
  for (const u of users) {
    console.log('USER:', u)
    const { rows: locs } = await pool.query(
      `select ul."locationId", l.name
         from user_locations ul
         left join locations l on l.id = ul."locationId"
        where ul."userId" = $1`,
      [u.id],
    )
    console.log('  locations:', locs)
    const { rows: creds } = await pool.query(
      `select "providerId" from account where "userId" = $1`,
      [u.id],
    )
    console.log('  credentials:', creds)
  }
}

const { rows: invites } = await pool.query(
  `select email, role, "locationId", "acceptedAt", "expiresAt" from invitations where lower(email) = lower($1) order by "createdAt" desc`,
  [email],
)
console.log('INVITES:', invites)

await pool.end()
