// Temp verification user. Public sign-up is disabled, so insert directly with
// pg, hashing the password with Better Auth's own hasher so sign-in works.
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'

const email = 'v0-verify@example.com'
const password = 'VerifyPass123!'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const existing = await pool.query('SELECT id FROM "user" WHERE email = $1', [
    email,
  ])
  if (existing.rows.length > 0) {
    console.log('CREATED (already exists)')
    return
  }
  const id = randomUUID()
  const now = new Date()
  const hashed = await hashPassword(password)
  await pool.query(
    'INSERT INTO "user" (id, email, name, "emailVerified", role, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, email, 'V0 Verify', true, 'admin', now, now],
  )
  await pool.query(
    'INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), id, 'credential', id, hashed, now, now],
  )
  console.log('CREATED')
}
main()
  .then(() => pool.end())
  .catch((e) => {
    console.log('ERR', e.message)
    pool.end()
    process.exit(1)
  })
