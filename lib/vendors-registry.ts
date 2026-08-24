// Vendor identity resolution shared by the validation editor and the Vendors
// page. Server-only (touches the db); not a 'use server' module so it can also
// export plain synchronous helpers.
//
// Why normalization exists: `products.supplier` is free text typed by site
// champions, while vendor identity everywhere else (vendor_prices, the savings
// vendor filter) hangs off the `vendors` table. Without a normalized match,
// "PHILLIPS 66" and "Phillips66" become two separate vendors and the vendor
// list fragments.
import { db } from '@/lib/db'
import { products, vendors } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

// Case- and punctuation-insensitive identity key. Drops everything that isn't
// alphanumeric, so "PHILLIPS 66", "Phillips 66", "Phillips-66" and "Phillips66"
// all collapse to "phillips66".
export function normalizeVendorKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// The same normalization expressed in SQL, so lookups can run in the database
// rather than pulling the whole vendor table into memory. Kept adjacent to
// normalizeVendorKey above: the two must stay in step.
const normalizedSql = (col: typeof vendors.name | typeof products.supplier) =>
  sql`lower(regexp_replace(${col}, '[^a-zA-Z0-9]', '', 'g'))`

export type ResolvedVendor = {
  id: number
  /** The canonical name as stored on the vendor record. */
  name: string
  /** True when this call inserted a brand-new vendor. */
  created: boolean
}

// Resolve a typed supplier name to a vendor record, creating one if no existing
// vendor matches. Returns null for blank input.
//
// Callers should persist the returned `name` rather than the raw input, so a
// variant spelling doesn't introduce a new string into products.supplier.
export async function resolveOrCreateVendor(
  userId: string,
  rawName: string,
): Promise<ResolvedVendor | null> {
  const trimmed = rawName.trim()
  const key = normalizeVendorKey(trimmed)
  // A name made entirely of punctuation has no identity to key on.
  if (!key) return null

  const [existing] = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(sql`${normalizedSql(vendors.name)} = ${key}`)
    .limit(1)

  if (existing) return { ...existing, created: false }

  const [created] = await db
    .insert(vendors)
    .values({ userId, name: trimmed })
    .returning({ id: vendors.id, name: vendors.name })

  return { ...created, created: true }
}

export type VendorNameVariant = { supplier: string; productCount: number }
export type VendorVariantGroup = {
  key: string
  /** Canonical spelling, taken from the `vendors` row when one exists. */
  canonicalName: string
  vendorId: number | null
  /** Spellings that differ from canonicalName, and how many products use them. */
  variants: VendorNameVariant[]
  /** Total products that would be rewritten by a merge. */
  affectedProducts: number
}

// Find supplier spellings that share a normalized key but differ in raw form.
// Surfaced on the Vendors page as an explicit, opt-in cleanup rather than being
// applied silently, since it rewrites existing product rows.
export async function findVendorNameVariants(): Promise<VendorVariantGroup[]> {
  const rows = await db
    .select({
      key: sql<string>`${normalizedSql(products.supplier)}`.as('key'),
      supplier: products.supplier,
      productCount: sql<number>`count(*)::int`.as('product_count'),
    })
    .from(products)
    .where(sql`${products.supplier} is not null and ${products.supplier} <> ''`)
    .groupBy(sql`1`, products.supplier)

  const vendorRows = await db
    .select({
      key: sql<string>`${normalizedSql(vendors.name)}`.as('key'),
      id: vendors.id,
      name: vendors.name,
    })
    .from(vendors)

  const vendorByKey = new Map(vendorRows.map((v) => [v.key, v]))

  const grouped = new Map<string, VendorNameVariant[]>()
  for (const r of rows) {
    if (!r.supplier) continue
    const list = grouped.get(r.key) ?? []
    list.push({ supplier: r.supplier, productCount: Number(r.productCount) })
    grouped.set(r.key, list)
  }

  const groups: VendorVariantGroup[] = []
  for (const [key, list] of grouped) {
    if (list.length < 2) continue
    const vendor = vendorByKey.get(key) ?? null
    // Anchor on the vendors row when there is one, since that name is what
    // vendor pricing and the savings filter already key off. Otherwise fall
    // back to the most-used spelling.
    const canonicalName =
      vendor?.name ??
      [...list].sort((a, b) => b.productCount - a.productCount)[0].supplier
    const variants = list
      .filter((v) => v.supplier !== canonicalName)
      .sort((a, b) => b.productCount - a.productCount)
    if (variants.length === 0) continue
    groups.push({
      key,
      canonicalName,
      vendorId: vendor?.id ?? null,
      variants,
      affectedProducts: variants.reduce((s, v) => s + v.productCount, 0),
    })
  }

  return groups.sort((a, b) => b.affectedProducts - a.affectedProducts)
}

// Rewrite every variant spelling in one group to the canonical name. Only
// touches products.supplier: import_rows.vendorName is raw import provenance
// and match_feedback.vendorName is training data, both of which should keep
// recording what was actually seen.
export async function mergeVendorNameVariants(
  key: string,
  canonicalName: string,
): Promise<{ updated: number }> {
  const updated = await db
    .update(products)
    .set({ supplier: canonicalName })
    .where(
      sql`${normalizedSql(products.supplier)} = ${key} and ${products.supplier} <> ${canonicalName}`,
    )
    .returning({ id: products.id })

  return { updated: updated.length }
}
