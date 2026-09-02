import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const c = await pool.connect()
try {
  const u = await c.query(`SELECT id, name, email, role, "createdAt" FROM "user" ORDER BY "createdAt"`)
  console.log(JSON.stringify(u.rows, null, 2))
} finally { c.release(); await pool.end() }
