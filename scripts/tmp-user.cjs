const { Pool } = require('pg')
const { hashPassword } = require('better-auth/crypto')
const crypto = require('crypto')

async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL })
  const email = 'v0-verify@example.com'
  const uid = crypto.randomUUID()
  const aid = crypto.randomUUID()
  const hash = await hashPassword('VerifyPass123!')
  await p.query(
    `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1,$2,'V0 Verify',true,now(),now())
     ON CONFLICT (email) DO NOTHING`,
    [uid, email],
  )
  const u = await p.query(`SELECT id FROM "user" WHERE email=$1`, [email])
  const userId = u.rows[0].id
  await p.query(
    `INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt")
     VALUES ($1,$2,'credential',$3,$4,now(),now())
     ON CONFLICT DO NOTHING`,
    [aid, userId, userId, hash],
  )
  console.log('CREATED', email)
  await p.end()
}
main().catch((e) => {
  console.log('ERR', e.message)
  process.exit(1)
})
