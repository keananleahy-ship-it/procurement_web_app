// One-time / re-runnable backfill that derives the hierarchy attributes
// (category, subcategory, viscosity, packageType, supplier) for every product
// and canonical item from its name + pack size.
//
// Rows a reviewer has hand-corrected (attributesEdited = true) are skipped so a
// re-run never clobbers manual fixes.
//
// Run with:
//   node --env-file-if-exists=/vercel/share/.env.project scripts/derive-attributes.ts
//
// Node 24 strips TypeScript types natively, so this .ts file runs directly.

import { Pool } from 'pg'
import { deriveAttributes } from '../lib/attributes.ts'

const connectionString =
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''

if (!connectionString) {
  console.error('[derive] No DATABASE_URL / POSTGRES_URL in env')
  process.exit(1)
}

const pool = new Pool({ connectionString })

async function deriveProducts() {
  const { rows } = await pool.query<{
    id: number
    name: string
    packSize: string | null
    supplier: string | null
  }>(`
    SELECT p.id, p.name, p."packSize",
           (
             SELECT ven.name
             FROM vendor_prices vp
             JOIN vendors ven ON ven.id = vp."vendorId"
             WHERE vp."productId" = p.id
             LIMIT 1
           ) AS supplier
    FROM products p
    WHERE p."attributesEdited" = false
    ORDER BY p.id
  `)

  console.log(`[derive] products to process: ${rows.length}`)
  let n = 0
  for (const r of rows) {
    const packSize = r.packSize != null ? Number(r.packSize) : undefined
    const a = deriveAttributes(r.name, packSize)
    await pool.query(
      `UPDATE products
         SET category = $2,
             subcategory = $3,
             viscosity = $4,
             "packageType" = $5,
             supplier = $6
       WHERE id = $1`,
      [r.id, a.category, a.subcategory, a.viscosity, a.packageType, r.supplier],
    )
    if (++n % 250 === 0) console.log(`[derive]   products ${n}/${rows.length}`)
  }
  console.log(`[derive] products done: ${n}`)
}

async function deriveCanonical() {
  const { rows } = await pool.query<{ id: number; name: string }>(`
    SELECT id, name FROM canonical_items
    WHERE "attributesEdited" = false
    ORDER BY id
  `)

  console.log(`[derive] canonical items to process: ${rows.length}`)
  let n = 0
  for (const r of rows) {
    const a = deriveAttributes(r.name)
    await pool.query(
      `UPDATE canonical_items
         SET category = $2,
             subcategory = $3,
             viscosity = $4
       WHERE id = $1`,
      [r.id, a.category, a.subcategory, a.viscosity],
    )
    n++
  }
  console.log(`[derive] canonical items done: ${n}`)
}

async function main() {
  try {
    await deriveProducts()
    await deriveCanonical()
    console.log('[derive] complete')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[derive] failed:', err)
  process.exit(1)
})
