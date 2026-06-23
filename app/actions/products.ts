'use server'

import { db } from '@/lib/db'
import { products } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function getProducts() {
  await requireUser()
  return db.select().from(products).orderBy(asc(products.name))
}

export async function createProduct(formData: FormData) {
  const { id: userId } = await requireEditor()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Product name is required')
  const category = String(formData.get('category') ?? '').trim() || null
  const sku = String(formData.get('sku') ?? '').trim() || null
  const unit = String(formData.get('unit') ?? '').trim() || null

  await db.insert(products).values({ userId, name, category, sku, unit })
  revalidatePath('/products')
  revalidatePath('/')
}

export async function deleteProduct(id: number) {
  await requireEditor()
  await db.delete(products).where(eq(products.id, id))
  revalidatePath('/products')
  revalidatePath('/')
}
