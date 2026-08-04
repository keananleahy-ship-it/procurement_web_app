const { Pool } = require('pg')
async function main() {
  const { hashPassword } = await import('better-auth/crypto')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const email = 'v0-verify@example.com'
  const password = 'VerifyPass123!'
  const now = new Date()
  const userId = 'v0verify-' + Math.random().toString(36).slice(2, 10)
  const acctId = 'v0acct-' + Math.random().toString(36).slice(2, 10)
  await pool.query('DELETE FROM account WHERE "userId" IN (SELECT id FROM "user" WHERE email=$1)', [email])
  await pool.query('DELETE FROM "user" WHERE email=$1', [email])
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified",role,"createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$5,$5)', [userId, 'V0 Verify', email, 'admin', now])
  const hash = await hashPassword(password)
  await pool.query('INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$6)', [acctId, userId, 'credential', userId, hash, now])
  console.log('CREATED')
  await pool.end()
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
