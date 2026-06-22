'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { products } from '@/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getProducts() {
  const userId = await getUserId()
  return db
    .select()
    .from(products)
    .where(eq(products.userId, userId))
    .orderBy(asc(products.name))
}

export async function createProduct(formData: FormData) {
  const userId = await getUserId()
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
  const userId = await getUserId()
  await db
    .delete(products)
    .where(and(eq(products.id, id), eq(products.userId, userId)))
  revalidatePath('/products')
  revalidatePath('/')
}
