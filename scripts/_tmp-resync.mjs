import { Pool } from 'pg'
import { randomUUID, scryptSync, randomBytes } from 'node:crypto'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const EMAIL = 'v0-resync-verify@example.com'
const PASSWORD = 'TempVerify123!'

// Better Auth stores scrypt hashes as "salt:hash" (hex) using scrypt params
// N=16384, r=16, p=1, dkLen=64. Mirror those exactly so the temp user can sign
// in through the normal flow.
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const N = 16384
  const r = 16
  const p = 1
  const hash = scryptSync(password.normalize('NFKC'), salt, 64, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  }).toString('hex')
  return `${salt}:${hash}`
}

async function create() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const uid = randomUUID()
    await client.query(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",role) VALUES ($1,$2,$3,true,now(),now(),$4)',
      [uid, 'Resync Verify', EMAIL, 'admin'],
    )
    await client.query(
      'INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())',
      [randomUUID(), uid, 'credential', uid, hashPassword(PASSWORD)],
    )
    // Location
    const loc = (
      await client.query(
        'INSERT INTO locations (name,"userId","createdAt") VALUES ($1,$2,now()) RETURNING id',
        ['Resync Test Plant', uid],
      )
    ).rows[0]

    // Canonical item + one product with a SKU, linked
    const canon = (
      await client.query(
        'INSERT INTO canonical_items (name,category,"baseUnit","userId","createdAt") VALUES ($1,$2,$3,$4,now()) RETURNING id',
        ['Resync Oil ISO 68', 'Hydraulic', 'gallon', uid],
      )
    ).rows[0]
    const prod = (
      await client.query(
        'INSERT INTO products (name,unit,category,sku,"packSize","baseUnit","canonicalItemId","userId","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id',
        [
          'Resync Oil ISO 68 - Drum',
          'gallon',
          'Hydraulic',
          'RSYNC-68',
          '1',
          'gallon',
          canon.id,
          uid,
        ],
      )
    ).rows[0]

    // A committed volume import whose staging row is CONFIRMED but was NEVER
    // written to purchase_volumes — simulating a match improved after commit.
    const imp = (
      await client.query(
        'INSERT INTO volume_imports ("userId","locationId","fileName","fileType","blobPathname","defaultPeriod",status,"rowCount","createdAt","committedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()) RETURNING id',
        [
          uid,
          loc.id,
          'ResyncTest.xls',
          'xls',
          'tmp/resync-test.xls',
          '2026',
          'committed',
          0,
        ],
      )
    ).rows[0]
    await client.query(
      'INSERT INTO volume_import_rows ("volumeImportId","userId","itemName",sku,"annualVolume","baseUnit","baselineUnitCost",period,"canonicalItemId","matchName","matchStatus","matchScore",include,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,now())',
      [
        imp.id,
        uid,
        'ZZZ RESYNC ITEM',
        'RSYNC-68',
        1200,
        'gallon',
        8.75,
        '2026',
        canon.id,
        'Resync Oil ISO 68',
        'confirmed',
        '1.0000',
      ],
    )
    await client.query('COMMIT')
    console.log(
      `[v0] created uid=${uid} loc=${loc.id} canon=${canon.id} prod=${prod.id} import=${imp.id}`,
    )
    const pv = (
      await client.query(
        "SELECT count(*)::int n FROM purchase_volumes WHERE \"userId\"=$1 AND source='import'",
        [uid],
      )
    ).rows[0]
    console.log(`[v0] purchase_volumes before resync: ${pv.n} (expected 0)`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
    await pool.end()
  }
}

async function cleanup() {
  const uid = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [EMAIL])
  ).rows[0]?.id
  if (!uid) {
    console.log('[v0] no temp user to clean')
    await pool.end()
    return
  }
  for (const sql of [
    'DELETE FROM volume_import_rows WHERE "userId"=$1',
    'DELETE FROM volume_imports WHERE "userId"=$1',
    'DELETE FROM purchase_volumes WHERE "userId"=$1',
    'DELETE FROM products WHERE "userId"=$1',
    'DELETE FROM canonical_items WHERE "userId"=$1',
    'DELETE FROM locations WHERE "userId"=$1',
    'DELETE FROM session WHERE "userId"=$1',
    'DELETE FROM account WHERE "userId"=$1',
    'DELETE FROM "user" WHERE id=$1',
  ]) {
    const r = await pool.query(sql, [uid])
    console.log(`[v0] ${sql.split(' ')[2]}: ${r.rowCount}`)
  }
  await pool.end()
}

const cmd = process.argv[2]
if (cmd === 'create') await create()
else if (cmd === 'cleanup') await cleanup()
else {
  console.log('usage: create | cleanup')
  await pool.end()
}
