import { Pool } from 'pg'

const EMAIL = 'keananleahy@leahywolf.com'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const u = await pool.query(
    `select id, name, email, role, "emailVerified", "createdAt" from "user" where email = $1`,
    [EMAIL],
  )
  if (u.rows.length === 0) {
    console.log(JSON.stringify({ found: false }))
    return
  }
  const row = u.rows[0]

  const accounts = await pool.query(
    `select "providerId", (password is not null) as "hasPassword" from account where "userId" = $1`,
    [row.id],
  )

  const assignments = await pool.query(
    `select ul."locationId", l.name
       from user_locations ul
       left join locations l on l.id = ul."locationId"
      where ul."userId" = $1`,
    [row.id],
  )

  const pendingInvites = await pool.query(
    `select id, status, role, "expiresAt" from invitations where email = $1 order by "createdAt" desc`,
    [EMAIL],
  )

  console.log(
    JSON.stringify(
      {
        found: true,
        user: row,
        accounts: accounts.rows,
        assignments: assignments.rows,
        invitesForEmail: pendingInvites.rows,
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
