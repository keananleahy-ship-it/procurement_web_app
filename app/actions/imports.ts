'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  imports,
  importRows,
  vendors,
  products,
  vendorPrices,
} from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { del } from '@vercel/blob'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getImports() {
  const userId = await getUserId()
  return db
    .select()
    .from(imports)
    .where(eq(imports.userId, userId))
    .orderBy(desc(imports.createdAt))
}

export async function getImportWithRows(importId: number) {
  const userId = await getUserId()
  const [imp] = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
  if (!imp) return null
  const rows = await db
    .select()
    .from(importRows)
    .where(and(eq(importRows.importId, importId), eq(importRows.userId, userId)))
    .orderBy(importRows.id)
  return { import: imp, rows }
}

type RowPatch = {
  productName?: string
  vendorName?: string | null
  unitPrice?: string | null
  shippingCost?: string
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
  const userId = await getUserId()
  await db
    .update(importRows)
    .set(patch)
    .where(and(eq(importRows.id, rowId), eq(importRows.userId, userId)))
  revalidatePath('/imports')
}

export async function deleteImportRow(rowId: number) {
  const userId = await getUserId()
  await db
    .delete(importRows)
    .where(and(eq(importRows.id, rowId), eq(importRows.userId, userId)))
  revalidatePath('/imports')
}

export async function discardImport(importId: number) {
  const userId = await getUserId()
  const [imp] = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
  if (!imp) throw new Error('Import not found')

  // Remove the stored original file and staging rows, mark discarded.
  try {
    await del(imp.blobPathname)
  } catch (err) {
    console.error('[v0] blob delete failed:', err)
  }
  await db
    .delete(importRows)
    .where(and(eq(importRows.importId, importId), eq(importRows.userId, userId)))
  await db
    .update(imports)
    .set({ status: 'discarded' })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
  revalidatePath('/imports')
}

// Resolve a vendor/product by name (case-insensitive), creating it if missing.
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
  const userId = await getUserId()

  const [imp] = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
  if (!imp) throw new Error('Import not found')
  if (imp.status === 'committed') {
    throw new Error('This import has already been committed')
  }

  const rows = await db
    .select()
    .from(importRows)
    .where(and(eq(importRows.importId, importId), eq(importRows.userId, userId)))

  // Preload existing vendors/products for case-insensitive matching.
  const existingVendors = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.userId, userId))
  const existingProducts = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, userId))

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
      shippingCost: r.shippingCost,
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
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))

  revalidatePath('/imports')
  revalidatePath('/prices')
  revalidatePath('/')
  return { committed, skipped }
}
