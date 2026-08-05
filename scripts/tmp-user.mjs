import { Pool } from 'pg'
import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'

const email = 'v0-verify@example.com'
const password = 'VerifyPass123!'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const uid = randomUUID()
const hash = await hashPassword(password)
await pool.query(
  `INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
   VALUES ($1,$2,$3,true,'admin',now(),now())
   ON CONFLICT (email) DO NOTHING`,
  [uid, 'V0 Verify', email],
)
const { rows: [u] } = await pool.query(`SELECT id FROM "user" WHERE email=$1`, [email])
await pool.query(
  `INSERT INTO account (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt")
   VALUES ($1,$2,'credential',$3,$4,now(),now())
   ON CONFLICT DO NOTHING`,
  [randomUUID(), u.id, u.id, hash],
)
console.log('CREATED', email)
await pool.end()
