'use server'

import { db } from '@/lib/db'
import { vendorPrices } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function getPrices() {
  await requireUser()
  return db.select().from(vendorPrices).orderBy(desc(vendorPrices.createdAt))
}

export async function createPrice(formData: FormData) {
  const { id: userId } = await requireEditor()

  const productId = Number(formData.get('productId'))
  const vendorId = Number(formData.get('vendorId'))
  if (!productId || !vendorId) {
    throw new Error('Product and vendor are required')
  }

  const locationRaw = formData.get('locationId')
  const locationId =
    locationRaw && String(locationRaw) !== '' ? Number(locationRaw) : null

  const unitPrice = String(formData.get('unitPrice') ?? '0')
  const currency = String(formData.get('currency') ?? 'USD').trim() || 'USD'

  const freightRaw = String(formData.get('freightTerms') ?? 'fob')
  const freightTerms = ['fob', 'delivered', 'both'].includes(freightRaw)
    ? freightRaw
    : 'fob'

  // Freight is only relevant when the buyer pays it (FOB or the FOB side of
  // 'both'). A pure delivered quote carries no separate freight.
  const shippingCost =
    freightTerms === 'delivered'
      ? '0'
      : String(formData.get('shippingCost') ?? '0') || '0'

  // A delivered alternative price only applies to 'both'.
  const deliveredRaw = formData.get('deliveredPrice')
  const deliveredPrice =
    freightTerms === 'both' && deliveredRaw && String(deliveredRaw) !== ''
      ? String(deliveredRaw)
      : null

  await db.insert(vendorPrices).values({
    userId,
    productId,
    vendorId,
    locationId,
    unitPrice,
    shippingCost,
    freightTerms,
    deliveredPrice,
    currency,
  })
  revalidatePath('/prices')
  revalidatePath('/')
}

export async function deletePrice(id: number) {
  await requireEditor()
  await db.delete(vendorPrices).where(eq(vendorPrices.id, id))
  revalidatePath('/prices')
  revalidatePath('/')
}

// Set an estimated per-unit inbound freight on an FOB offer so it can be
// rationalized against delivered offers. Passing 0/empty clears the estimate.
export async function setFreightEstimate(id: number, perUnitFreight: number) {
  await requireEditor()
  const value =
    Number.isFinite(perUnitFreight) && perUnitFreight > 0 ? perUnitFreight : 0
  await db
    .update(vendorPrices)
    .set({
      shippingCost: value.toFixed(2),
      freightEstimated: value > 0,
    })
    .where(eq(vendorPrices.id, id))
  revalidatePath('/compare')
  revalidatePath('/prices')
  revalidatePath('/')
}
