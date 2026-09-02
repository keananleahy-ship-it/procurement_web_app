import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const c = await pool.connect()
try {
  const col = await c.query(`SELECT data_type, udt_name, column_default FROM information_schema.columns WHERE table_name='user' AND column_name='role'`)
  console.log('COLUMN:', JSON.stringify(col.rows, null, 2))
  const cons = await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"user"'::regclass`)
  console.log('CONSTRAINTS:', JSON.stringify(cons.rows, null, 2))
  // try a harmless test: what enum values if any
  const en = await c.query(`SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid=e.enumtypid WHERE t.typname LIKE '%role%'`)
  console.log('ENUMS:', JSON.stringify(en.rows, null, 2))
} finally { c.release(); await pool.end() }
