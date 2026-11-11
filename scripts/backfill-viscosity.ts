// Re-runnable backfill that puts every product's `viscosity` into the standard
// form defined in lib/viscosity.ts. Pass --apply to write; otherwise dry run.
//
// - Any recognizable value is reformatted (formatting only, so it applies to
//   human-edited rows too: "15W40" -> "SAE 15W-40").
// - Un-edited rows with a missing/unrecognizable value, or a truncated one
//   ("SAE 10W" when the name says 10W-30), are re-derived from the name.
// - Human-edited rows whose value isn't a grade are left alone and listed for
//   review rather than overwritten.
import { Pool } from 'pg'
import { normalizeViscosity, viscosityFromName } from '../lib/viscosity.ts'

type Row = { id: number; name: string; viscosity: string | null; attributesEdited: boolean }

async function main() {
  const apply = process.argv.includes('--apply')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query<Row>(
      `SELECT id, name, viscosity, "attributesEdited" FROM products ORDER BY id`,
    )
    const updates: { id: number; from: string | null; to: string | null; why: string }[] = []
    const review: Row[] = []

    for (const r of rows) {
      const normalized = normalizeViscosity(r.viscosity)
      const fromName = viscosityFromName(r.name)
      let target: string | null = normalized
      let why = 'reformat'

      if (!r.attributesEdited) {
        if (!normalized && fromName) {
          target = fromName
          why = r.viscosity ? 'replace invalid' : 'fill from name'
        } else if (!normalized && r.viscosity) {
          target = null
          why = 'clear invalid'
        } else if (normalized && fromName && fromName.startsWith(`${normalized}-`)) {
          target = fromName
          why = 'expand truncated'
        }
      } else if (!normalized && r.viscosity) {
        review.push(r)
        continue
      }

      if ((target ?? null) !== (r.viscosity ?? null)) {
        updates.push({ id: r.id, from: r.viscosity, to: target, why })
      }
    }

    const byWhy = new Map<string, number>()
    for (const u of updates) byWhy.set(u.why, (byWhy.get(u.why) ?? 0) + 1)
    console.log(`[viscosity] ${rows.length} products, ${updates.length} changes`, Object.fromEntries(byWhy))
    for (const why of byWhy.keys()) {
      for (const u of updates.filter((x) => x.why === why).slice(0, 4)) {
        console.log(`  ${why}: #${u.id} ${JSON.stringify(u.from)} -> ${JSON.stringify(u.to)}`)
      }
    }
    console.log(`[viscosity] edited rows needing review: ${review.length}`)
    for (const r of review) console.log(`  #${r.id} ${JSON.stringify(r.viscosity)}  ${r.name}`)

    if (apply) {
      for (const u of updates) {
        await pool.query(`UPDATE products SET viscosity = $2 WHERE id = $1`, [u.id, u.to])
      }
      console.log('[viscosity] applied')
    } else {
      console.log('[viscosity] dry run (pass --apply to write)')
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[viscosity] error', e)
  process.exit(1)
})
