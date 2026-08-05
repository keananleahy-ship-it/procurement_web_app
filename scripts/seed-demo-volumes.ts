// Demo seed: realistic annual purchase volumes for the Engine Oil category,
// keyed by canonical item + location, so the (already-built) savings engine in
// app/actions/comparisons.ts lights up the Compare and Overview screens with
// real annualized dollar opportunities.
//
// Idempotent: every row it writes is tagged source='demo', and the script
// clears prior source='demo' rows before inserting, so it can be re-run and
// cleanly removed (DELETE FROM purchase_volumes WHERE source='demo').
//
// Run: node --env-file-if-exists=/vercel/share/.env.project scripts/seed-demo-volumes.ts
import { Pool } from 'pg'

const SOURCE = 'demo'
const PERIOD = 'TTM'

// Deterministic 0..1 hash so re-runs produce identical volumes.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// A rough annual base volume (in gallons) for an engine-oil group, from its
// name. Mirrors how a real distributor buys: conventional high-runner PCMO and
// fleet HDEO move the most; full synthetics and niche grades move less.
function baseVolumeFor(name: string): number {
  const n = name.toLowerCase()
  const isHeavy = n.includes('heavy-duty') || n.includes('heavy duty')
  const isFullSyn = n.includes('full synthetic')
  const isBlend = n.includes('synthetic blend')
  if (isHeavy && !isFullSyn) return isBlend ? 18000 : 26000 // fleet HDEO
  if (isHeavy && isFullSyn) return 7000 // premium HDEO
  if (isFullSyn) return 16000 // full-syn PCMO (growing share)
  if (isBlend) return 12000 // blend PCMO
  return 22000 // conventional PCMO high runner
}

type Group = {
  canonicalItemId: number
  name: string
  baseUnit: string | null
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const {
      rows: [{ userId }],
    } = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM products WHERE "userId" IS NOT NULL LIMIT 1`,
    )

    const { rows: locs } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM locations ORDER BY id`,
    )
    if (locs.length === 0) throw new Error('no locations to seed against')
    // Relative buying weight per site (Chicago hub biggest). Falls back to an
    // even split if the demo location names differ.
    const weightByName: Record<string, number> = {
      Chicago: 0.45,
      'New York': 0.35,
      Amarillo: 0.2,
    }
    const locWeights = locs.map((l) => ({
      ...l,
      weight: weightByName[l.name] ?? 1 / locs.length,
    }))

    // Engine-oil canonical groups that actually have confirmed products and
    // more than one vendor, so there is a real price gap for volume to weight.
    const { rows: groups } = await pool.query<Group>(
      `SELECT c.id AS "canonicalItemId", c.name, c."baseUnit"
         FROM canonical_items c
         JOIN products p
           ON p."canonicalItemId" = c.id AND p."matchStatus" = 'confirmed'
         JOIN vendor_prices vp ON vp."productId" = p.id
        WHERE c.category = 'Engine Oil'
        GROUP BY c.id, c.name, c."baseUnit"
       HAVING count(DISTINCT vp."vendorId") >= 2
        ORDER BY c.id`,
    )

    await pool.query(`DELETE FROM purchase_volumes WHERE source = $1`, [SOURCE])

    let inserted = 0
    let totalVol = 0
    for (const g of groups) {
      const base = baseVolumeFor(g.name)
      // ±30% deterministic jitter on the group's total.
      const jitter = 0.7 + rand(g.canonicalItemId) * 0.6
      const groupTotal = base * jitter

      for (const [i, loc] of locWeights.entries()) {
        // For realism, not every product is bought at every site: skip the
        // smallest-weight site for ~1 in 3 groups (deterministic).
        const skip =
          loc.weight <= 0.25 && rand(g.canonicalItemId * 7 + i) < 0.34
        if (skip) continue

        const vol = Math.round((groupTotal * loc.weight) / 10) * 10
        if (vol <= 0) continue

        await pool.query(
          `INSERT INTO purchase_volumes
             ("userId", "canonicalItemId", "productId", "locationId",
              "annualVolume", "baseUnit", period, source)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
          [userId, g.canonicalItemId, loc.id, vol, g.baseUnit, PERIOD, SOURCE],
        )
        inserted++
        totalVol += vol
      }
    }

    console.log(
      `[seed-volumes] groups=${groups.length} rows=${inserted} totalAnnualVolume=${totalVol.toLocaleString()} ${groups[0]?.baseUnit ?? ''}`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[seed-volumes] error', e)
  process.exit(1)
})
