import { Pool } from 'pg'
import {
  attributeVerdict,
  deriveSpecKey,
  normalizeGrade,
} from '../lib/match-key.ts'

// READ-ONLY verification of the attribute-gate design against live data.
// Answers, before any behavior ships:
//   1. Is the legacy canonical_items.specKey vocabulary reproducible from the
//      current attribute columns? (If not, deriving both sides is mandatory.)
//   2. How many confirmed matches would the gates flag as conflicting?
//   3. Does the gate veto the known-bad EP COMPOUND / grease pairings?
//   4. How many products get an exact derived-spec-key match (tier 0)?
// Performs no writes whatsoever.

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows

type Row = {
  id: number
  name: string
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
}

async function main() {
  // --- 1. Legacy specKey reproducibility ----------------------------------
  const legacy = await q<Row & { specKey: string | null }>(
    `select id, name, category, application, subcategory, viscosity, "specKey"
     from canonical_items where "specKey" is not null limit 200`,
  )
  let reproducible = 0
  for (const r of legacy) {
    if (deriveSpecKey(r) === r.specKey) reproducible++
  }
  console.log('[1] legacy specKey rows:', legacy.length)
  console.log('    reproducible from current columns:', reproducible)
  console.log('    sample:')
  for (const r of legacy.slice(0, 3)) {
    console.log(`      stored=${r.specKey}  derived=${deriveSpecKey(r)}`)
  }

  // --- 2. Confirmed matches the gates would flag --------------------------
  const confirmed = await q<{
    pid: number
    pname: string
    pcat: string | null
    papp: string | null
    psub: string | null
    pvisc: string | null
    cid: number
    cname: string
    ccat: string | null
    capp: string | null
    csub: string | null
    cvisc: string | null
  }>(
    `select p.id pid, p.name pname, p.category pcat, p.application papp,
            p.subcategory psub, p.viscosity pvisc,
            c.id cid, c.name cname, c.category ccat, c.application capp,
            c.subcategory csub, c.viscosity cvisc
     from products p join canonical_items c on c.id = p."canonicalItemId"
     where p."matchStatus" = 'confirmed'`,
  )
  const flagged = confirmed.filter(
    (r) =>
      attributeVerdict(
        { name: r.pname, category: r.pcat, application: r.papp, subcategory: r.psub, viscosity: r.pvisc },
        { name: r.cname, category: r.ccat, application: r.capp, subcategory: r.csub, viscosity: r.cvisc },
      ).hasConflict,
  )
  console.log('\n[2] confirmed matches:', confirmed.length)
  console.log('    flagged as conflicting:', flagged.length)
  const byAttr = { category: 0, viscosity: 0, both: 0 }
  for (const r of flagged) {
    const v = attributeVerdict(
      { category: r.pcat, viscosity: r.pvisc },
      { category: r.ccat, viscosity: r.cvisc },
    )
    if (v.conflicting.length > 1) byAttr.both++
    else if (v.conflicting[0] === 'category') byAttr.category++
    else byAttr.viscosity++
  }
  console.log('    by attribute:', JSON.stringify(byAttr))
  console.log('    sample flagged:')
  for (const r of flagged.slice(0, 6)) {
    console.log(`      "${r.pname}" (${r.pcat}/${r.pvisc})`)
    console.log(`        -> "${r.cname}" (${r.ccat}/${r.cvisc})`)
  }

  // --- 3. The known-bad pairings ------------------------------------------
  const ep = confirmed.filter((r) => /EP\s*COMPOUND/i.test(r.pname))
  console.log('\n[3] EP COMPOUND confirmed matches:', ep.length)
  for (const r of ep) {
    const v = attributeVerdict(
      { category: r.pcat, viscosity: r.pvisc },
      { category: r.ccat, viscosity: r.cvisc },
    )
    console.log(
      `      "${r.pname}" -> "${r.cname}" | vetoed=${v.hasConflict} (${v.conflicting.join(',') || 'none'})`,
    )
  }

  // --- 4. Tier-0 reach: exact derived spec-key matches --------------------
  const cans = await q<Row>(
    `select id, name, category, application, subcategory, viscosity from canonical_items`,
  )
  const pend = await q<Row>(
    `select id, name, category, application, subcategory, viscosity
     from products where "matchStatus" not in ('confirmed','rejected','excluded')`,
  )
  const keyed = new Map<string, number[]>()
  for (const c of cans) {
    const k = deriveSpecKey(c)
    if (!k) continue
    keyed.set(k, [...(keyed.get(k) ?? []), c.id])
  }
  let exact = 0
  let ambiguous = 0
  for (const p of pend) {
    const k = deriveSpecKey(p)
    if (!k) continue
    const hit = keyed.get(k)
    if (!hit) continue
    if (hit.length === 1) exact++
    else ambiguous++
  }
  console.log('\n[4] canonical items with a derivable key:', keyed.size, '/', cans.length)
  console.log('    pending products:', pend.length)
  console.log('    unique exact key hits (tier 0):', exact)
  console.log('    ambiguous key hits (>1 canonical):', ambiguous)

  // --- 5. Grade normalization sanity -------------------------------------
  const grades = await q<{ viscosity: string; n: string }>(
    `select viscosity, count(*)::text n from products
     where viscosity is not null group by viscosity order by count(*) desc limit 12`,
  )
  console.log('\n[5] viscosity spellings -> normalized:')
  for (const g of grades) {
    console.log(`      ${String(g.viscosity).padEnd(14)} x${g.n.padEnd(4)} -> ${normalizeGrade(g.viscosity)}`)
  }

  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  await pool.end()
  process.exit(1)
})
