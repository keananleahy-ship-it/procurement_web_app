// TEMPORARY throwaway script — creates or deletes a temp admin user for
// browser verification of the Purchase Volumes UI. Deleted after use.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { hashPassword } from 'better-auth/crypto'

const TEST_EMAIL = 'v0-temp-verify@example.com'
const TEST_PASSWORD = 'TempVerify123!'
const TEST_NAME = 'v0 Temp Verify'

const mode = process.argv[2]
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function cleanup() {
  const { rows } = await pool.query('SELECT id FROM "user" WHERE email=$1', [
    TEST_EMAIL,
  ])
  for (const r of rows) {
    await pool.query('DELETE FROM session WHERE "userId"=$1', [r.id])
    await pool.query('DELETE FROM account WHERE "userId"=$1', [r.id])
    await pool.query('DELETE FROM "user" WHERE id=$1', [r.id])
  }
  console.log('[v0] cleaned up temp users:', rows.length)
}

await cleanup()

if (mode === 'delete') {
  await pool.end()
  process.exit(0)
}

const hashed = await hashPassword(TEST_PASSWORD)
const now = new Date()
const userId = randomUUID()
await pool.query(
  'INSERT INTO "user" (id, email, name, "emailVerified", role, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [userId, TEST_EMAIL, TEST_NAME, true, 'admin', now, now],
)
await pool.query(
  'INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [randomUUID(), userId, 'credential', userId, hashed, now, now],
)
console.log('[v0] created temp admin:', TEST_EMAIL)
await pool.end()
process.exit(0)
