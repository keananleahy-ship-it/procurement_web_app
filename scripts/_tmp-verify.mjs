import { Pool } from 'pg'
import { hashPassword } from 'better-auth/crypto'
import { randomUUID } from 'node:crypto'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const EMAIL = 'v0-rematch-verify@example.com'
const PASSWORD = 'TempVerify123!'

async function create() {
  const uid = randomUUID()
  const now = new Date()
  await pool.query(
    'INSERT INTO "user" (id,email,name,"emailVerified",role,"createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$5,$5)',
    [uid, EMAIL, 'Rematch Verify', 'admin', now],
  )
  const hash = await hashPassword(PASSWORD)
  await pool.query(
    'INSERT INTO account (id,"userId","accountId","providerId",password,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$6)',
    [randomUUID(), uid, EMAIL, 'credential', hash, now],
  )

  // Seed a canonical comparison group: 2 vendors priced $9 and $7 per gallon,
  // one product carries a SKU so re-match can pick it up.
  const ci = await pool.query(
    'INSERT INTO canonical_items ("userId",name,category,unit,"baseUnit") VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [uid, 'Rematch Test Oil ISO 68', 'oil', 'gallon', 'gallon'],
  )
  const canonId = ci.rows[0].id
  const v1 = await pool.query('INSERT INTO vendors ("userId",name) VALUES ($1,$2) RETURNING id', [uid, 'RM Vendor A'])
  const v2 = await pool.query('INSERT INTO vendors ("userId",name) VALUES ($1,$2) RETURNING id', [uid, 'RM Vendor B'])
  const p1 = await pool.query(
    'INSERT INTO products ("userId",name,category,unit,"canonicalItemId","matchStatus","packSize","baseUnit",sku) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [uid, 'Rematch Test Oil ISO 68 - A', 'oil', 'gallon', canonId, 'confirmed', 1, 'gallon', 'RMTEST-68'],
  )
  const p2 = await pool.query(
    'INSERT INTO products ("userId",name,category,unit,"canonicalItemId","matchStatus","packSize","baseUnit") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [uid, 'Rematch Test Oil ISO 68 - B', 'oil', 'gallon', canonId, 'confirmed', 1, 'gallon'],
  )
  await pool.query(
    'INSERT INTO vendor_prices ("userId","productId","vendorId","unitPrice","packSize","baseUnit","priceBasis") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uid, p1.rows[0].id, v1.rows[0].id, '9.00', 1, 'gallon', 'pack'],
  )
  await pool.query(
    'INSERT INTO vendor_prices ("userId","productId","vendorId","unitPrice","packSize","baseUnit","priceBasis") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uid, p2.rows[0].id, v2.rows[0].id, '7.00', 1, 'gallon', 'pack'],
  )

  // A pending volume import whose single row carries the vendor SKU but a
  // garbage item label, so ONLY SKU re-matching can resolve it.
  const loc = await pool.query('SELECT id FROM locations LIMIT 1')
  const locId = loc.rows[0].id
  const imp = await pool.query(
    'INSERT INTO volume_imports ("userId","locationId","fileName","blobPathname","fileType","defaultPeriod",status,"rowCount") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [uid, locId, 'rematch-test.csv', 'tmp/rematch-test.csv', 'xls', 'TTM 2025', 'pending', 1],
  )
  await pool.query(
    'INSERT INTO volume_import_rows ("userId","volumeImportId","itemName",sku,"annualVolume","baseUnit","baselineUnitCost",period,"matchStatus",include) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',
    [uid, imp.rows[0].id, 'ZZZ UNKNOWN LABEL', 'RMTEST-68', '1200', 'gallon', '8.75', 'TTM 2025', 'unmatched'],
  )
  console.log('[v0] uid=' + uid + ' importId=' + imp.rows[0].id)
}

async function cleanup() {
  const u = await pool.query('SELECT id FROM "user" WHERE email=$1', [EMAIL])
  if (!u.rows.length) { console.log('[v0] no temp user'); return }
  const uid = u.rows[0].id
  for (const t of ['volume_import_rows', 'volume_imports', 'purchase_volumes', 'vendor_prices', 'products', 'vendors', 'canonical_items', 'session', 'account']) {
    const r = await pool.query('DELETE FROM ' + t + ' WHERE "userId"=$1', [uid])
    console.log('[v0] ' + t + ':', r.rowCount)
  }
  await pool.query('DELETE FROM "user" WHERE id=$1', [uid])
  console.log('[v0] deleted temp user')
}

const mode = process.argv[2]
;(mode === 'cleanup' ? cleanup() : create())
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1) })
