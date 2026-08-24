'use server'

import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import {
  findVendorNameVariants,
  mergeVendorNameVariants,
  type VendorVariantGroup,
} from '@/lib/vendors-registry'
import { asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function getVendors() {
  // Shared workspace: any authenticated user (including viewers) sees all data.
  await requireUser()
  return db.select().from(vendors).orderBy(asc(vendors.name))
}

export async function createVendor(formData: FormData) {
  const { id: userId } = await requireEditor()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Vendor name is required')
  const contactEmail = String(formData.get('contactEmail') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null

  await db.insert(vendors).values({ userId, name, contactEmail, notes })
  revalidatePath('/vendors')
  revalidatePath('/')
}

// Supplier spellings that collapse to the same vendor identity. Read-only.
export async function getVendorNameVariants(): Promise<VendorVariantGroup[]> {
  await requireUser()
  return findVendorNameVariants()
}

// Apply one variant group, rewriting products.supplier to the canonical name.
// Deliberately per-group and user-triggered: it edits existing product rows.
export async function mergeVendorNames(key: string, canonicalName: string) {
  await requireEditor()
  const { updated } = await mergeVendorNameVariants(key, canonicalName)
  revalidatePath('/vendors')
  revalidatePath('/validation')
  revalidatePath('/products')
  revalidatePath('/')
  return { updated }
}

export async function deleteVendor(id: number) {
  await requireEditor()
  await db.delete(vendors).where(eq(vendors.id, id))
  revalidatePath('/vendors')
  revalidatePath('/')
}
