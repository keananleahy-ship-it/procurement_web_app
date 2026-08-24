// One-time data fix: link the reviewer-approved Citgo products to their
// canonical items so Citgo's existing prices become comparable offers.
// Runs in a transaction and only touches rows that are still undecided.
const { Client } = require('pg')

// Reviewed and approved pairings. 'manual' marks the one target a human
// corrected away from the AI's proposal.
const PAIRS = [
  { p: 2375, c: 415, s: '0.9000', m: 'ai', r: 'HYDURANCE AW FLD 32 = AW hydraulic ISO 32.' },
  { p: 2376, c: 416, s: '0.9000', m: 'ai', r: 'HYDURANCE AW FLD 46 = AW hydraulic ISO 46.' },
  { p: 2377, c: 420, s: '0.9000', m: 'ai', r: 'HYDURANCE AW FLD 68 = AW hydraulic ISO 68.' },
  { p: 2378, c: 418, s: '0.9000', m: 'ai', r: 'HYDURANCE AW FLD 100 = AW hydraulic ISO 100.' },
  { p: 2362, c: 408, s: '0.9000', m: 'ai', r: 'CITGARD 600 HDEO 15W-40 = heavy-duty engine oil 15W-40.' },
  { p: 2363, c: 405, s: '0.9000', m: 'ai', r: 'CITGARD 1000 FULL SYN HDEO 5W-30 = full synthetic HD 5W-30.' },
  { p: 2364, c: 409, s: '0.9000', m: 'ai', r: 'CITGARD 700 SYNBLD HDEO 10W-30 = synthetic blend HD 10W-30.' },
  { p: 2365, c: 409, s: '0.9000', m: 'ai', r: 'CITGARD 700 MFE SYNBLD 10W-30 grouped with synthetic blend HD 10W-30 (tier variant, reviewer approved).' },
  { p: 2366, c: 461, s: '0.9000', m: 'ai', r: 'CITGARD 700 SYNBLD HDEO 15W-40 = synthetic blend HD 15W-40.' },
  { p: 2370, c: 461, s: '0.9000', m: 'ai', r: 'CITGARD 800 SYNBLD HDEO 15W-40 grouped with synthetic blend HD 15W-40 (tier variant, reviewer approved).' },
  { p: 2385, c: 508, s: '0.9000', m: 'ai', r: 'SUPERGARD FULL SYN 5W-20 = full synthetic passenger 5W-20.' },
  { p: 2383, c: 432, s: '0.9000', m: 'ai', r: 'SUPERGARD SYNBLD 5W-20 = synthetic blend passenger 5W-20.' },
  { p: 2384, c: 433, s: '0.9000', m: 'ai', r: 'SUPERGARD SYNBLD 5W-30 = synthetic blend passenger 5W-30.' },
  { p: 2387, c: 435, s: '0.9000', m: 'ai', r: 'SUPERGARD SYN 5W-30 = synthetic passenger 5W-30.' },
  { p: 2386, c: 426, s: '0.9000', m: 'manual', r: 'SUPERGARD SYN 0W-20: reviewer corrected AI target from #430 (Conventional) to #426 (Synthetic), matching the SYN tier and its 5W-30 sibling.' },
]

// Left deliberately unmatched: EP Compound 68/150/220/320 (2367/2368/2369/2379)
// are extreme-pressure industrial gear lubricants; the AI matched them to
// Circulating Oil on ISO grade alone. No correct canonical target exists.

;(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  })
  await c.connect()
  try {
    await c.query('begin')

    let updated = 0
    const skipped = []
    for (const { p, c: cid, s, m, r } of PAIRS) {
      // Guard keeps this idempotent and non-destructive: it only fills in rows
      // that are still unmatched, so an existing decision is never clobbered.
      const res = await c.query(
        `update products set "canonicalItemId"=$2, "matchStatus"='confirmed',
           "matchScore"=$3, "matchMethod"=$4, "matchReason"=$5
         where id=$1 and "canonicalItemId" is null and "matchStatus"='unmatched'
         returning id`,
        [p, cid, s, m, r.slice(0, 280)],
      )
      if (res.rowCount === 1) updated++
      else skipped.push(p)
    }

    console.log('linked: ' + updated + ' of ' + PAIRS.length)
    if (skipped.length) console.log('skipped (already decided): ' + skipped.join(', '))

    const v = await c.query(
      `select pr."matchStatus" st, count(distinct pr.id)::int n,
              count(pr."canonicalItemId")::int linked
       from vendor_prices vp join products pr on pr.id=vp."productId"
       where vp."vendorId"=7 group by 1 order by 1`,
    )
    console.log('--- Citgo products by status ---')
    v.rows.forEach((x) =>
      console.log('  ' + String(x.st).padEnd(11) + 'count=' + x.n + ' linked=' + x.linked),
    )

    const ep = await c.query(
      `select count(*)::int n from products
       where id = any($1) and ("canonicalItemId" is not null or "matchStatus" <> 'unmatched')`,
      [[2367, 2368, 2369, 2379]],
    )
    console.log('EP Compound rows touched (must be 0): ' + ep.rows[0].n)

    if (updated !== 15 || ep.rows[0].n !== 0) {
      await c.query('rollback')
      console.log('!! UNEXPECTED RESULT -> ROLLED BACK, no data changed')
      return
    }

    await c.query('commit')
    console.log('COMMITTED')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    console.error('ERR (rolled back):', e.message)
  } finally {
    await c.end()
  }
})()
