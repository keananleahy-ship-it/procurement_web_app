import { Pool } from 'pg'
import { attributeVerdict } from '../lib/match-key.ts'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows

async function main() {
  const rows = await q<any>(
    `select p.id, p.name, p.category pcat, p.viscosity pvisc, p."matchStatus",
            p."matchMethod", p."matchScore", c.name cname, c.category ccat,
            c.viscosity cvisc
     from products p left join canonical_items c on c.id = p."canonicalItemId"
     where p.name ilike '%EP%COMPOUND%' order by p.name limit 20`,
  )
  console.log('EP COMPOUND rows:', rows.length)
  for (const r of rows) {
    const v = r.cname
      ? attributeVerdict(
          { category: r.pcat, viscosity: r.pvisc },
          { category: r.ccat, viscosity: r.cvisc },
        )
      : null
    console.log(`\n"${r.name}"  [${r.matchStatus}/${r.matchMethod ?? '-'}]`)
    console.log(`   product: cat=${r.pcat} visc=${r.pvisc}`)
    console.log(`   canon:   ${r.cname ?? '(none)'} cat=${r.ccat ?? '-'} visc=${r.cvisc ?? '-'}`)
    if (v) console.log(`   gate: vetoed=${v.hasConflict} conflicting=${v.conflicting.join(',') || 'none'}`)
  }
  await pool.end()
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1) })
