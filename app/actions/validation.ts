'use server'

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import {
  attributeSuggestions,
  locations,
  products,
  purchaseVolumes,
  userLocations,
} from '@/lib/db/schema'
import {
  requireUser,
  requireEditor,
  canAdmin,
  type SessionUser,
} from '@/lib/roles'
import {
  PRODUCT_ATTRIBUTES,
  VALIDATION_ATTRIBUTE_KEYS,
  type AttributeKey,
} from '@/lib/attributes'
import {
  suggestAttributes,
  ATTRIBUTE_FILL_MODEL,
  type AttributeFillInput,
} from '@/lib/attributes-ai'
import { isMeasureUom } from '@/lib/uom'

// Detect a purchase record whose captured unit can't be a real volume/weight
// measure, which quietly distorts the savings math. Two high-confidence cases:
//   - the unit starts with a digit ("55", "16 gallon", "1.06") — a pack size or
//     descriptor leaked into the unit field; a real unit never starts with a
//     number.
//   - the unit is a container/count word (case, each, drum…) on a BULK product,
//     which should be measured in gallons, not counted in cases.
// Returns a short reason for display, or null when the unit looks fine. Packaged
// (non-bulk) items legitimately counted in cases/each are intentionally NOT
// flagged, to keep the signal actionable.
function detectUnitIssue(
  baseUnit: string | null,
  packageType: string | null,
): string | null {
  const raw = (baseUnit ?? '').trim().toLowerCase()
  if (raw === '') return null
  if (/^\d/.test(raw)) return 'Unit looks like a pack size, not a measure'
  if (!isMeasureUom(raw) && (packageType ?? '').toLowerCase() === 'bulk') {
    return 'Bulk item captured in a container/count unit, not gallons'
  }
  return null
}

const VALIDATION_ATTR_SET = new Set<AttributeKey>(VALIDATION_ATTRIBUTE_KEYS)
const PRODUCT_ATTR_KEYS = new Set<AttributeKey>(
  PRODUCT_ATTRIBUTES.map((a) => a.key),
)

export type AccessibleLocation = {
  id: number
  name: string
  region: string | null
}

// A pending AI proposal for a single missing attribute on a product. Rendered
// inside the empty cell as an "accept / edit / dismiss" affordance; it only
// exists while pending (accepting or dismissing removes it).
export type AttributeSuggestionView = {
  attribute: AttributeKey
  value: string
  confidence: number | null
  rationale: string | null
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
  // short reason when the captured unit looks wrong (pack size or count on a
  // bulk item); null when the unit looks fine
  unitIssue: string | null
  // pending AI suggestions for this product's missing attributes, keyed by
  // attribute (at most one per attribute). Empty when none are pending.
  suggestions: Partial<Record<AttributeKey, AttributeSuggestionView>>
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
    // Highest-volume records first so champions spend their attention where it
    // moves the most spend. Records with no captured volume sort last rather
    // than leading the table (Postgres sorts NULLs first on DESC by default).
    // Name is a stable tiebreaker so equal volumes don't shuffle between loads.
    .orderBy(
      sql`${purchaseVolumes.annualVolume} desc nulls last`,
      asc(products.name),
    )

  // Pending AI suggestions for the products shown here, grouped by productId.
  const productIds = Array.from(new Set(rows.map((r) => r.productId)))
  const suggestionsByProduct = new Map<
    number,
    Partial<Record<AttributeKey, AttributeSuggestionView>>
  >()
  if (productIds.length > 0) {
    const sugg = await db
      .select()
      .from(attributeSuggestions)
      .where(inArray(attributeSuggestions.productId, productIds))
    for (const s of sugg) {
      const key = s.attribute as AttributeKey
      if (!VALIDATION_ATTR_SET.has(key)) continue
      const bucket = suggestionsByProduct.get(s.productId) ?? {}
      bucket[key] = {
        attribute: key,
        value: s.value,
        confidence: s.confidence != null ? Number(s.confidence) : null,
        rationale: s.rationale,
      }
      suggestionsByProduct.set(s.productId, bucket)
    }
  }

  const records: ValidationRecord[] = rows.map((r) => {
    const hasGaps =
      !r.category ||
      !r.application ||
      !r.subcategory ||
      !r.viscosity ||
      !r.packageType
    const unitIssue = detectUnitIssue(r.baseUnit, r.packageType)
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
      unitIssue,
      suggestions: suggestionsByProduct.get(r.productId) ?? {},
    }
  })

  const progress: ValidationProgress = {
    total: records.length,
    validated: records.filter((r) => r.validated).length,
    needsAttention: records.filter(
      (r) => (r.hasGaps || r.unitIssue !== null) && !r.validated,
    ).length,
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

// How many top-volume products the AI pass considers in one run. Kept modest so
// a run is fast and cheap, and so the champion reviews a focused, high-impact
// batch rather than the whole catalog at once.
const AI_SUGGEST_LIMIT = 40

// AI Catalog Validation pass. Focuses on the products with the LARGEST share of
// THIS LOCATION's purchase volume (highest-impact first), proposes values for
// their MISSING attributes, and stages them as pending suggestions for the
// champion to accept or edit. Nothing is written to the product — suggestions
// live in attribute_suggestions until accepted. Re-running refreshes the
// pending set for the same products (upsert by product+attribute) and never
// overwrites a value a champion already filled (only missing attributes are
// requested).
export async function suggestAttributesForLocation(
  locationId: number,
): Promise<{ productsConsidered: number; suggestionsCreated: number }> {
  const u = await requireEditor()
  await assertLocationAccess(u, locationId)

  // Rank this location's product-linked records by annual volume (desc), then
  // take the top N distinct products that still have at least one missing
  // validation attribute.
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      packSize: products.packSize,
      baseUnit: products.baseUnit,
      category: products.category,
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
      packageType: products.packageType,
      supplier: products.supplier,
      brand: products.brand,
      annualVolume: purchaseVolumes.annualVolume,
    })
    .from(purchaseVolumes)
    .innerJoin(products, eq(products.id, purchaseVolumes.productId))
    .where(eq(purchaseVolumes.locationId, locationId))
    .orderBy(desc(purchaseVolumes.annualVolume))

  const inputs: AttributeFillInput[] = []
  const seen = new Set<number>()
  for (const r of rows) {
    if (seen.has(r.productId)) continue
    const current: Record<AttributeKey, string | null> = {
      supplier: r.supplier,
      brand: r.brand,
      category: r.category,
      application: r.application,
      subcategory: r.subcategory,
      viscosity: r.viscosity,
      packageType: r.packageType,
    }
    const missing = VALIDATION_ATTRIBUTE_KEYS.filter((k) => !current[k])
    if (missing.length === 0) continue
    seen.add(r.productId)
    inputs.push({
      productId: r.productId,
      name: r.name,
      packSize: r.packSize != null ? Number(r.packSize) : null,
      baseUnit: r.baseUnit,
      current,
      missing,
    })
    if (inputs.length >= AI_SUGGEST_LIMIT) break
  }

  if (inputs.length === 0) {
    return { productsConsidered: 0, suggestionsCreated: 0 }
  }

  const proposed = await suggestAttributes(inputs)
  if (proposed.length === 0) {
    return { productsConsidered: inputs.length, suggestionsCreated: 0 }
  }

  // Upsert each proposal by (productId, attribute): refresh value/rationale on
  // re-run rather than duplicating. The unique index backs the conflict target.
  for (const p of proposed) {
    await db
      .insert(attributeSuggestions)
      .values({
        userId: u.id,
        productId: p.productId,
        attribute: p.attribute,
        value: p.value,
        confidence: p.confidence.toFixed(2),
        rationale: p.rationale || null,
        model: ATTRIBUTE_FILL_MODEL,
      })
      .onConflictDoUpdate({
        target: [
          attributeSuggestions.productId,
          attributeSuggestions.attribute,
        ],
        set: {
          value: p.value,
          confidence: p.confidence.toFixed(2),
          rationale: p.rationale || null,
          model: ATTRIBUTE_FILL_MODEL,
          userId: u.id,
          createdAt: new Date(),
        },
      })
  }

  revalidatePath('/validation')
  return {
    productsConsidered: inputs.length,
    suggestionsCreated: proposed.length,
  }
}

// Accept a pending AI suggestion: apply its value to the product (like a manual
// edit — same global effect and sign-off clearing) and delete the suggestion.
export async function acceptSuggestion(input: {
  productId: number
  locationId: number
  key: AttributeKey
}): Promise<{ clearedSignOffs: number }> {
  const u = await requireUser()
  await assertLocationAccess(u, input.locationId)
  if (
    !VALIDATION_ATTR_SET.has(input.key) ||
    !PRODUCT_ATTR_KEYS.has(input.key)
  ) {
    throw new Error(`Attribute "${input.key}" is not editable here`)
  }

  const [sugg] = await db
    .select()
    .from(attributeSuggestions)
    .where(
      and(
        eq(attributeSuggestions.productId, input.productId),
        eq(attributeSuggestions.attribute, input.key),
      ),
    )
    .limit(1)
  if (!sugg) throw new Error('Suggestion no longer exists')

  await db
    .update(products)
    .set({ [input.key]: sugg.value, attributesEdited: true })
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

  await db
    .delete(attributeSuggestions)
    .where(
      and(
        eq(attributeSuggestions.productId, input.productId),
        eq(attributeSuggestions.attribute, input.key),
      ),
    )

  revalidatePath('/validation')
  revalidatePath('/products')
  revalidatePath('/compare')
  revalidatePath('/')
  return { clearedSignOffs: cleared.length }
}

// Dismiss a pending AI suggestion without applying it.
export async function dismissSuggestion(input: {
  productId: number
  locationId: number
  key: AttributeKey
}): Promise<void> {
  const u = await requireUser()
  await assertLocationAccess(u, input.locationId)
  await db
    .delete(attributeSuggestions)
    .where(
      and(
        eq(attributeSuggestions.productId, input.productId),
        eq(attributeSuggestions.attribute, input.key),
      ),
    )
  revalidatePath('/validation')
}
