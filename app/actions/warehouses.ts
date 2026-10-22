'use server'

import { pool } from '@/lib/db'
import { requireUser, requireEditor } from '@/lib/roles'
import { revalidatePath } from 'next/cache'

export type WarehouseRow = {
  id: number
  company: string
  code: string
  region: string | null
  locationId: number
  gallons: number
  cost: number
  products: number
}

export async function getWarehouses(): Promise<WarehouseRow[]> {
  await requireUser()
  const exists = await pool.query(`SELECT to_regclass('public.warehouses') AS t`)
  if (!exists.rows[0]?.t) return []
  const { rows } = await pool.query(`
    SELECT w.id, w.company, w.code, w.region, w."locationId",
           coalesce(sum(v."annualVolume"), 0)::float AS gallons,
           coalesce(sum(v."totalCost"), 0)::float AS cost,
           count(v.id)::int AS products
    FROM warehouses w
    LEFT JOIN warehouse_volumes v ON v."warehouseId" = w.id
    GROUP BY w.id
    ORDER BY w.company, gallons DESC`)
  return rows
}

// Moves a warehouse to another main location and re-derives the
// location-level rollup (purchase_volumes, source='warehouse') for both the old
// and new location. Catalog-validation sign-offs are carried over per
// location + product.
export async function reassignWarehouse(warehouseId: number, locationId: number) {
  await requireEditor()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const wh = await client.query(
      `SELECT "locationId", "userId" FROM warehouses WHERE id = $1 FOR UPDATE`,
      [warehouseId],
    )
    if (!wh.rows[0]) throw new Error('Warehouse not found')
    const loc = await client.query(`SELECT id FROM locations WHERE id = $1`, [locationId])
    if (!loc.rows[0]) throw new Error('Location not found')
    const oldLocationId: number = wh.rows[0].locationId
    if (oldLocationId === locationId) {
      await client.query('ROLLBACK')
      return
    }
    await client.query(`UPDATE warehouses SET "locationId" = $2 WHERE id = $1`, [
      warehouseId,
      locationId,
    ])
    const locs = [oldLocationId, locationId]

    const signoffs = await client.query(
      `SELECT "locationId", "productId", "validatedAt", "validatedByUserId", "validatedByName"
       FROM purchase_volumes
       WHERE source = 'warehouse' AND "locationId" = ANY($1) AND "validatedAt" IS NOT NULL`,
      [locs],
    )
    await client.query(
      `DELETE FROM purchase_volumes WHERE source = 'warehouse' AND "locationId" = ANY($1)`,
      [locs],
    )
    await client.query(
      `INSERT INTO purchase_volumes
         ("userId", "canonicalItemId", "productId", "locationId", "annualVolume", "baseUnit",
          "baselineUnitCost", period, source)
       SELECT w."userId", p."canonicalItemId", v."productId", w."locationId",
              sum(v."annualVolume"), 'gallon',
              CASE WHEN sum(v."totalCost") > 0
                   THEN round(sum(v."totalCost") / sum(v."annualVolume"), 4) END,
              max(v.period), 'warehouse'
       FROM warehouse_volumes v
       JOIN warehouses w ON w.id = v."warehouseId"
       JOIN products p ON p.id = v."productId"
       WHERE w."locationId" = ANY($1)
       GROUP BY w."userId", p."canonicalItemId", v."productId", w."locationId"`,
      [locs],
    )
    for (const s of signoffs.rows) {
      await client.query(
        `UPDATE purchase_volumes
           SET "validatedAt" = $3, "validatedByUserId" = $4, "validatedByName" = $5
         WHERE source = 'warehouse' AND "locationId" = $1 AND "productId" = $2`,
        [s.locationId, s.productId, s.validatedAt, s.validatedByUserId, s.validatedByName],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  revalidatePath('/volumes')
  revalidatePath('/')
}
