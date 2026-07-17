'use server'

import { db } from '@/lib/db'
import {
  imports,
  importRows,
  vendors,
  products,
  vendorPrices,
} from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { desc, eq, inArray } from 'drizzle-orm'
import { del } from '@vercel/blob'
import { revalidatePath } from 'next/cache'

export async function getImports() {
  await requireUser()
  return db.select().from(imports).orderBy(desc(imports.createdAt))
}

export async function getImportWithRows(importId: number) {
  await requireUser()
  const [imp] = await db
    .select()
    .from(imports)
    .where(eq(imports.id, importId))
  if (!imp) return null
  const rows = await db
    .select()
    .from(importRows)
    .where(eq(importRows.importId, importId))
    .orderBy(importRows.id)
  return { import: imp, rows }
}

type RowPatch = {
  productName?: string
  vendorName?: string | null
  unitPrice?: string | null
  priceBasis?: string
  shippingCost?: string
  freightEstimated?: boolean
  freightTerms?: string
  deliveredPrice?: string | null
  minOrderQty?: number
  currency?: string
  unit?: string | null
  category?: string | null
  packSize?: string
  baseUnit?: string | null
  include?: boolean
}

export async function updateImportRow(rowId: number, patch: RowPatch) {
  await requireEditor()
  await db.update(importRows).set(patch).where(eq(importRows.id, rowId))
  revalidatePath('/imports')
}

// Apply one price-basis answer to many staged rows at once. Used by the
// sheet-level "priced per" prompt during import review, where a single
// consistent answer covers every ambiguous row on the sheet.
export async function setImportRowsBasis(
  rowIds: number[],
  basis: 'base' | 'pack',
) {
  await requireEditor()
  if (rowIds.length === 0) return
  await db
    .update(importRows)
    .set({ priceBasis: basis })
    .where(inArray(importRows.id, rowIds))
  revalidatePath('/imports')
}

export async function deleteImportRow(rowId: number) {
  await requireEditor()
  await db.delete(importRows).where(eq(importRows.id, rowId))
  revalidatePath('/imports')
}

export async function discardImport(importId: number) {
  await requireEditor()
  const [imp] = await db
    .select()
    .from(imports)
    .where(eq(imports.id, importId))
  if (!imp) throw new Error('Import not found')

  // Remove the stored original file and staging rows, mark discarded.
  try {
    await del(imp.blobPathname)
  } catch (err) {
    console.error('[v0] blob delete failed:', err)
  }
  await db.delete(importRows).where(eq(importRows.importId, importId))
  await db
    .update(imports)
    .set({ status: 'discarded' })
    .where(eq(imports.id, importId))
  revalidatePath('/imports')
}

// Resolve a vendor/product by name (case-insensitive), creating it if missing.
// New rows record the acting user as creator, but lookups span the workspace.
async function resolveVendorId(
  userId: string,
  name: string,
  cache: Map<string, number>,
) {
  const key = name.trim().toLowerCase()
  const existing = cache.get(key)
  if (existing) return existing
  const [created] = await db
    .insert(vendors)
    .values({ userId, name: name.trim() })
    .returning({ id: vendors.id })
  cache.set(key, created.id)
  return created.id
}

async function resolveProductId(
  userId: string,
  name: string,
  unit: string | null,
  category: string | null,
  packSize: string,
  baseUnit: string | null,
  cache: Map<string, number>,
) {
  const key = name.trim().toLowerCase()
  const existing = cache.get(key)
  if (existing) return existing
  const [created] = await db
    .insert(products)
    .values({
      userId,
      name: name.trim(),
      unit,
      category,
      packSize: packSize && Number(packSize) > 0 ? packSize : '1',
      baseUnit: baseUnit?.trim() || unit,
    })
    .returning({ id: products.id })
  cache.set(key, created.id)
  return created.id
}

export type CommitResult = {
  committed: number
  skipped: number
}

export async function commitImport(importId: number): Promise<CommitResult> {
  const { id: userId } = await requireEditor()

  const [imp] = await db
    .select()
    .from(imports)
    .where(eq(imports.id, importId))
  if (!imp) throw new Error('Import not found')
  if (imp.status === 'committed') {
    throw new Error('This import has already been committed')
  }

  const rows = await db
    .select()
    .from(importRows)
    .where(eq(importRows.importId, importId))

  // Preload existing vendors/products for case-insensitive matching across the
  // shared workspace (not scoped to the acting user).
  const existingVendors = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
  const existingProducts = await db
    .select({ id: products.id, name: products.name })
    .from(products)

  const vendorCache = new Map<string, number>()
  for (const v of existingVendors) vendorCache.set(v.name.toLowerCase(), v.id)
  const productCache = new Map<string, number>()
  for (const p of existingProducts) productCache.set(p.name.toLowerCase(), p.id)

  let committed = 0
  let skipped = 0

  for (const r of rows) {
    // Need an includable row with a price and a vendor to create an offer.
    if (!r.include || r.unitPrice === null || !r.vendorName?.trim()) {
      skipped++
      continue
    }
    const vendorId = await resolveVendorId(userId, r.vendorName, vendorCache)
    const productId = await resolveProductId(
      userId,
      r.productName,
      r.unit,
      r.category,
      r.packSize,
      r.baseUnit,
      productCache,
    )

    await db.insert(vendorPrices).values({
      userId,
      productId,
      vendorId,
      locationId: imp.locationId,
      unitPrice: r.unitPrice,
      priceBasis: r.priceBasis === 'base' ? 'base' : 'pack',
      shippingCost: r.shippingCost,
      freightEstimated: r.freightEstimated,
      freightTerms: r.freightTerms,
      deliveredPrice: r.deliveredPrice,
      minOrderQty: r.minOrderQty,
      currency: r.currency,
      effectiveDate: imp.effectiveDate,
      importId: imp.id,
    })
    committed++
  }

  await db
    .update(imports)
    .set({
      status: 'committed',
      committedAt: new Date(),
      rowCount: committed,
    })
    .where(eq(imports.id, importId))

  revalidatePath('/imports')
  revalidatePath('/prices')
  revalidatePath('/')
  return { committed, skipped }
}
