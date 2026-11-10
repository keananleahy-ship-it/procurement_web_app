// Adds products.performanceSpec (if missing) and backfills it from the product
// name. Rows a reviewer edited (attributesEdited) are left alone.
// Run: node --env-file-if-exists=/vercel/share/.env.project --experimental-strip-types scripts/derive-spec.ts
import pg from 'pg'
import { deriveSpec } from '../lib/traits'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function main() {

  await pool.query(
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS "performanceSpec" text',
  )

  const { rows } = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM products WHERE NOT "attributesEdited" AND "performanceSpec" IS NULL',
  )

  let set = 0
  for (const r of rows) {
    const spec = deriveSpec(r.name)
    if (!spec) continue
    await pool.query('UPDATE products SET "performanceSpec" = $1 WHERE id = $2', [
      spec,
      r.id,
    ])
    set++
  }

  const { rows: dist } = await pool.query(
    'SELECT "performanceSpec" spec, count(*)::int n FROM products GROUP BY 1 ORDER BY 2 DESC LIMIT 25',
  )
  console.log(`Scanned ${rows.length}, set ${set}`)
  console.table(dist)
  await pool.end()
}

main()
