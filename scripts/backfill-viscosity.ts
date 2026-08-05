// Targeted, re-runnable backfill for the `viscosity` column only. Recomputes
// deriveViscosity for every product / canonical item that a human hasn't
// edited and writes the result (including clearing stale false positives such
// as a "1W" grade parsed from a pack code). Kept separate from
// derive-attributes.ts (which does a full overwrite) so it can't clobber
// LLM-filled brand/category/application/formulation values.
import { Pool } from 'pg'
import { deriveViscosity } from '../lib/attributes.ts'

async function backfill(
  pool: Pool,
  table: 'products' | 'canonical_items',
): Promise<void> {
  const { rows } = await pool.query<{
    id: number
    name: string
    viscosity: string | null
  }>(`
    SELECT id, name, viscosity FROM ${table}
    WHERE "attributesEdited" = false
    ORDER BY id
  `)
  console.log(`[backfill] ${table}: ${rows.length} candidates`)
  let changed = 0
  for (const r of rows) {
    const v = deriveViscosity(r.name)
    if (v === r.viscosity) continue
    await pool.query(
      `UPDATE ${table} SET viscosity = $2
       WHERE id = $1 AND "attributesEdited" = false`,
      [r.id, v],
    )
    changed++
  }
  console.log(`[backfill] ${table}: changed ${changed}`)
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await backfill(pool, 'products')
    await backfill(pool, 'canonical_items')
    console.log('[backfill] complete')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[backfill] error', e)
  process.exit(1)
})
