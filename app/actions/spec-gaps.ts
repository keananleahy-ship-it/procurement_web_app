'use server'

import { and, asc, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { products, purchaseVolumes } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { VALIDATION_ATTRIBUTE_KEYS, type AttributeKey } from '@/lib/attributes'
import type { GapItem } from '@/lib/spec-gaps'
import type { SpecDimension } from '@/lib/spec-group'

// Only the four hierarchy attributes that can form an equivalence key are
// writable from this screen. Keeping the allow-list narrow means the gap queue
// can never become a side door for editing arbitrary product columns.
const FILLABLE = new Set<SpecDimension>([
  'category',
  'application',
  'subcategory',
  'viscosity',
])
const VALIDATION_ATTRS = new Set<AttributeKey>(VALIDATION_ATTRIBUTE_KEYS)

/**
 * Every product plus its total purchase volume, for gap ranking.
 *
 * Deliberately a LEFT join: products with no purchase record are the majority
 * of the blocked set (1,350 of 2,087) and are precisely what the existing
 * per-location validation screen cannot reach. Inner-joining here would
 * reproduce that blind spot.
 */
export async function getGapItems(): Promise<GapItem[]> {
  await requireUser()
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      // Plain column read. Deriving the vendor from vendor_prices was measured
      // and rejected: all 295 products with a blank supplier but existing price
      // rows are ALREADY fully spec-keyed, and every one of the 101 "No vendor"
      // rows in this queue has no price rows at all. The two sets are disjoint,
      // so a fallback join changes no row and no ranking.
      supplier: products.supplier,
      category: products.category,
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
      annualVolume: sql<string>`coalesce(sum(${purchaseVolumes.annualVolume}), 0)`,
    })
    .from(products)
    .leftJoin(purchaseVolumes, eq(purchaseVolumes.productId, products.id))
    .groupBy(
      products.id,
      products.name,
      products.supplier,
      products.category,
      products.application,
      products.subcategory,
      products.viscosity,
    )
    .orderBy(asc(products.name))

  return rows.map((r) => ({
    ...r,
    annualVolume: Number(r.annualVolume) || 0,
  }))
}

/**
 * Fill one missing attribute on a product.
 *
 * Mirrors `updateValidationAttribute`'s side effects on purpose. The attribute
 * lives on the shared product, so the change is global, and any site that
 * already signed off did so against the old value — leaving those sign-offs
 * intact would silently convert a stale approval into apparent approval of data
 * nobody reviewed. Clearing them forces a re-confirm, and the count is returned
 * so the UI can say so out loud.
 */
export async function fillGapAttribute(input: {
  productId: number
  key: SpecDimension
  value: string | null
}): Promise<{ clearedSignOffs: number }> {
  const u = await requireEditor()
  if (!FILLABLE.has(input.key) || !VALIDATION_ATTRS.has(input.key)) {
    throw new Error(`Attribute "${input.key}" is not fillable here`)
  }
  const clean = input.value?.trim() ? input.value.trim() : null

  // No vendor-registration branch here (unlike the validation screen): only the
  // four hierarchy attributes are fillable from this queue, and `supplier` is
  // not one of them, so there is no vendor name to reconcile.
  await db
    .update(products)
    .set({ [input.key]: clean, attributesEdited: true })
    .where(eq(products.id, input.productId))

  const cleared = await db
    .update(purchaseVolumes)
    .set({ validatedAt: null, validatedByUserId: null, validatedByName: null })
    .where(
      and(
        eq(purchaseVolumes.productId, input.productId),
        sql`${purchaseVolumes.validatedAt} is not null`,
      ),
    )
    .returning({ id: purchaseVolumes.id })

  revalidatePath('/gaps')
  revalidatePath('/equivalents')
  revalidatePath('/validation')
  revalidatePath('/products')
  revalidatePath('/compare')
  revalidatePath('/')
  return { clearedSignOffs: cleared.length }
}
