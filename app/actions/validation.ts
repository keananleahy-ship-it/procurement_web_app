'use server'

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import {
  locations,
  products,
  purchaseVolumes,
  userLocations,
} from '@/lib/db/schema'
import {
  requireUser,
  canAdmin,
  type SessionUser,
} from '@/lib/roles'
import {
  PRODUCT_ATTRIBUTES,
  VALIDATION_ATTRIBUTE_KEYS,
  type AttributeKey,
} from '@/lib/attributes'

const VALIDATION_ATTR_SET = new Set<AttributeKey>(VALIDATION_ATTRIBUTE_KEYS)
const PRODUCT_ATTR_KEYS = new Set<AttributeKey>(
  PRODUCT_ATTRIBUTES.map((a) => a.key),
)

export type AccessibleLocation = {
  id: number
  name: string
  region: string | null
}

export type ValidationRecord = {
  // The purchase record ID — unique per site, always preserved.
  purchaseId: number
  locationId: number
  annualVolume: number
  baseUnit: string | null
  period: string | null
  // sign-off state
  validated: boolean
  validatedAt: string | null
  validatedByName: string | null
  // the shared product this record resolves to (attributes are global to it)
  productId: number
  vendorCode: string | null
  description: string
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
  packageType: string | null
  supplier: string | null
  brand: string | null
  // true when a catalog attribute is missing (drives the "needs attention"
  // filter so champions can target incomplete rows first)
  hasGaps: boolean
}

export type ValidationProgress = {
  total: number
  validated: number
  needsAttention: number
}

// Resolve which locations a user may review. Admins see every location; other
// users see only the ones they've been assigned as site champion for.
async function accessibleLocationIds(
  u: SessionUser,
): Promise<'all' | Set<number>> {
  if (canAdmin(u.role)) return 'all'
  const rows = await db
    .select({ locationId: userLocations.locationId })
    .from(userLocations)
    .where(eq(userLocations.userId, u.id))
  return new Set(rows.map((r) => r.locationId))
}

async function assertLocationAccess(
  u: SessionUser,
  locationId: number,
): Promise<void> {
  const ids = await accessibleLocationIds(u)
  if (ids === 'all') return
  if (!ids.has(locationId)) {
    throw new Error('Forbidden: you are not assigned to this location.')
  }
}

// Locations the current user may validate, for the page's location switcher.
export async function getAccessibleLocations(): Promise<AccessibleLocation[]> {
  const u = await requireUser()
  const ids = await accessibleLocationIds(u)
  const all = await db
    .select({ id: locations.id, name: locations.name, region: locations.region })
    .from(locations)
    .orderBy(asc(locations.name))
  if (ids === 'all') return all
  return all.filter((l) => ids.has(l.id))
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// All purchase records for a location, joined to their resolved product so the
// champion can read across code → description → attributes → record ID and sign
// off. Only product-linked records appear (a catalog row needs a product).
export async function getValidationRecords(locationId: number): Promise<{
  records: ValidationRecord[]
  progress: ValidationProgress
}> {
  const u = await requireUser()
  await assertLocationAccess(u, locationId)

  const rows = await db
    .select({
      purchaseId: purchaseVolumes.id,
      locationId: purchaseVolumes.locationId,
      annualVolume: purchaseVolumes.annualVolume,
      baseUnit: purchaseVolumes.baseUnit,
      period: purchaseVolumes.period,
      validatedAt: purchaseVolumes.validatedAt,
      validatedByName: purchaseVolumes.validatedByName,
      productId: products.id,
      vendorCode: products.sku,
      description: products.name,
      category: products.category,
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
      packageType: products.packageType,
      supplier: products.supplier,
      brand: products.brand,
    })
    .from(purchaseVolumes)
    .innerJoin(products, eq(products.id, purchaseVolumes.productId))
    .where(eq(purchaseVolumes.locationId, locationId))
    .orderBy(asc(products.name))

  const records: ValidationRecord[] = rows.map((r) => {
    const hasGaps =
      !r.category ||
      !r.application ||
      !r.subcategory ||
      !r.viscosity ||
      !r.packageType
    return {
      purchaseId: r.purchaseId,
      locationId: r.locationId ?? locationId,
      annualVolume: toNum(r.annualVolume),
      baseUnit: r.baseUnit,
      period: r.period,
      validated: r.validatedAt !== null,
      validatedAt: r.validatedAt ? r.validatedAt.toISOString() : null,
      validatedByName: r.validatedByName,
      productId: r.productId,
      vendorCode: r.vendorCode,
      description: r.description,
      category: r.category,
      application: r.application,
      subcategory: r.subcategory,
      viscosity: r.viscosity,
      packageType: r.packageType,
      supplier: r.supplier,
      brand: r.brand,
      hasGaps,
    }
  })

  const progress: ValidationProgress = {
    total: records.length,
    validated: records.filter((r) => r.validated).length,
    needsAttention: records.filter((r) => r.hasGaps && !r.validated).length,
  }
  return { records, progress }
}

// Correct a catalog attribute. The value lives on the SHARED product, so the
// change applies globally (every site that buys this SKU). Because the fix
// changes what other champions previously signed off on, sign-off is cleared
// on every purchase record pointing at this product, so each affected site
// re-confirms. `locationId` is the champion's current context and authorizes
// the edit (they must own that location, or be an admin).
export async function updateValidationAttribute(input: {
  productId: number
  locationId: number
  key: AttributeKey
  value: string | null
}): Promise<{ clearedSignOffs: number }> {
  const u = await requireUser()
  await assertLocationAccess(u, input.locationId)
  if (!VALIDATION_ATTR_SET.has(input.key) || !PRODUCT_ATTR_KEYS.has(input.key)) {
    throw new Error(`Attribute "${input.key}" is not editable here`)
  }
  const clean = input.value?.trim() ? input.value.trim() : null

  await db
    .update(products)
    .set({ [input.key]: clean, attributesEdited: true })
    .where(eq(products.id, input.productId))

  // Clear sign-off everywhere this product is purchased (re-confirm required).
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

  revalidatePath('/validation')
  revalidatePath('/products')
  revalidatePath('/compare')
  revalidatePath('/')
  return { clearedSignOffs: cleared.length }
}

// Sign off (or reopen) a single purchase record for the champion's location.
export async function setRecordValidated(
  purchaseId: number,
  validated: boolean,
): Promise<void> {
  const u = await requireUser()
  const [row] = await db
    .select({ locationId: purchaseVolumes.locationId })
    .from(purchaseVolumes)
    .where(eq(purchaseVolumes.id, purchaseId))
    .limit(1)
  if (!row?.locationId) throw new Error('Purchase record not found')
  await assertLocationAccess(u, row.locationId)

  await db
    .update(purchaseVolumes)
    .set(
      validated
        ? {
            validatedAt: new Date(),
            validatedByUserId: u.id,
            validatedByName: u.name,
          }
        : { validatedAt: null, validatedByUserId: null, validatedByName: null },
    )
    .where(eq(purchaseVolumes.id, purchaseId))
  revalidatePath('/validation')
}

// Sign off many records at once (e.g. "validate all remaining"). Defensively
// re-scopes the update to the location the champion is authorized for.
export async function bulkSetValidated(input: {
  locationId: number
  purchaseIds: number[]
  validated: boolean
}): Promise<{ count: number }> {
  const u = await requireUser()
  await assertLocationAccess(u, input.locationId)
  if (input.purchaseIds.length === 0) return { count: 0 }

  const updated = await db
    .update(purchaseVolumes)
    .set(
      input.validated
        ? {
            validatedAt: new Date(),
            validatedByUserId: u.id,
            validatedByName: u.name,
          }
        : { validatedAt: null, validatedByUserId: null, validatedByName: null },
    )
    .where(
      and(
        eq(purchaseVolumes.locationId, input.locationId),
        inArray(purchaseVolumes.id, input.purchaseIds),
      ),
    )
    .returning({ id: purchaseVolumes.id })
  revalidatePath('/validation')
  return { count: updated.length }
}
