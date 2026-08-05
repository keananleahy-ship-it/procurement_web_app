'use server'

import { db } from '@/lib/db'
import { products, canonicalItems } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  PRODUCT_ATTRIBUTES,
  CANONICAL_ATTRIBUTES,
  type AttributeKey,
} from '@/lib/attributes'

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

// Editable hierarchy attributes ---------------------------------------------
// Reviewers correct a derived attribute value. Only the attribute columns
// valid for the given entity are writable; setting any of them flips
// `attributesEdited` so the derivation script never clobbers the fix.
const PRODUCT_ATTR_KEYS = new Set<AttributeKey>(
  PRODUCT_ATTRIBUTES.map((a) => a.key),
)
const CANONICAL_ATTR_KEYS = new Set<AttributeKey>(
  CANONICAL_ATTRIBUTES.map((a) => a.key),
)

export async function updateProductAttribute(
  id: number,
  key: AttributeKey,
  value: string | null,
) {
  await requireEditor()
  if (!PRODUCT_ATTR_KEYS.has(key)) {
    throw new Error(`Attribute "${key}" is not editable on products`)
  }
  const clean = value?.trim() ? value.trim() : null
  await db
    .update(products)
    .set({ [key]: clean, attributesEdited: true })
    .where(eq(products.id, id))
  revalidatePath('/products')
  revalidatePath('/compare')
  revalidatePath('/')
}

export async function updateCanonicalAttribute(
  id: number,
  key: AttributeKey,
  value: string | null,
) {
  await requireEditor()
  if (!CANONICAL_ATTR_KEYS.has(key)) {
    throw new Error(`Attribute "${key}" is not editable on canonical items`)
  }
  const clean = value?.trim() ? value.trim() : null
  await db
    .update(canonicalItems)
    .set({ [key]: clean, attributesEdited: true })
    .where(eq(canonicalItems.id, id))
  revalidatePath('/canonical')
  revalidatePath('/compare')
  revalidatePath('/')
}
