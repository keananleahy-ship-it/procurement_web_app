import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS "locationId" integer')
  const cols = await pool.query(
    `select column_name from information_schema.columns
     where table_name = 'invitations' order by ordinal_position`,
  )
  console.log('[v0] invitations columns:', cols.rows.map((c) => c.column_name).join(', '))
}

main()
  .catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
  })
  .finally(() => pool.end())
