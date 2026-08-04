const { Pool } = require('pg')
const { hashPassword } = require('better-auth/crypto')
const { randomUUID } = require('crypto')

async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL })
  const email = 'v0-verify@example.com'
  const pw = await hashPassword('VerifyPass123!')
  const uid = randomUUID()
  await p.query(
    `INSERT INTO "user" (id, email, name, "emailVerified", role, "createdAt", "updatedAt")
     VALUES ($1,$2,'V0 Verify',true,'admin',now(),now())`,
    [uid, email],
  )
  await p.query(
    `INSERT INTO account (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
     VALUES ($1,$2,$3,'credential',$4,now(),now())`,
    [randomUUID(), uid, email, pw],
  )
  console.log('CREATED', email)
  await p.end()
}
main().catch((e) => { console.log('ERR', e.message); process.exit(1) })
