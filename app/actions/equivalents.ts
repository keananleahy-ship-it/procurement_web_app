'use server'

import { db } from '@/lib/db'
import { canonicalItems, products } from '@/lib/db/schema'
import { requireUser } from '@/lib/roles'
import { specValue, type SpecItem } from '@/lib/spec-group'
import { asc, eq } from 'drizzle-orm'

/**
 * Every product with the attributes that can form an equivalence key.
 *
 * The whole catalog is returned and grouped on the client so the dimension
 * toggles re-group instantly: the answer to "same spec except supplier" changes
 * with which dimensions are active, and a server round-trip per toggle would
 * make exploring the loosened/tightened variants feel unusable. At ~3.4k rows
 * of six short columns this is a small payload.
 */
export async function getSpecItems(): Promise<SpecItem[]> {
  await requireUser()
  return db
    .select({
      id: products.id,
      name: products.name,
      supplier: products.supplier,
      category: products.category,
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
    })
    .from(products)
    .orderBy(asc(products.name))
}

export type CanonicalSpread = {
  canonicalItemId: number
  canonicalItemName: string
  /** Distinct spec tuples held under this one canonical item. */
  specs: { label: string; productCount: number; exampleName: string }[]
  productCount: number
}

/**
 * Canonical items that hold products of MORE THAN ONE spec tuple.
 *
 * This is the audit that motivated spec grouping: because savings math groups
 * by canonicalItemId, a canonical item spanning several specs makes unlike
 * products compare as substitutes for each other — a grease valued against a
 * turbine oil. Reported read-only; nothing is regrouped or unlinked, because
 * some spreads are deliberate and the fix (correct the attribute, or split the
 * item) depends on which side is actually wrong.
 *
 * Uses the full category+application+formulation+viscosity tuple regardless of
 * the UI toggles: this is a data-integrity report, so it should surface every
 * spread rather than only those visible under the current view.
 */
export async function getCanonicalSpreads(): Promise<CanonicalSpread[]> {
  await requireUser()
  const rows = await db
    .select({
      canonicalItemId: products.canonicalItemId,
      canonicalItemName: canonicalItems.name,
      productId: products.id,
      productName: products.name,
      supplier: products.supplier,
      category: products.category,
      application: products.application,
      subcategory: products.subcategory,
      viscosity: products.viscosity,
    })
    .from(products)
    .innerJoin(canonicalItems, eq(canonicalItems.id, products.canonicalItemId))
    .orderBy(asc(canonicalItems.name))

  // canonicalItemId -> spec key -> members
  const byCanonical = new Map<
    number,
    { name: string; specs: Map<string, { label: string; names: string[] }> }
  >()

  for (const row of rows) {
    if (row.canonicalItemId == null) continue
    const item: SpecItem = {
      id: row.productId,
      name: row.productName,
      supplier: row.supplier,
      category: row.category,
      application: row.application,
      subcategory: row.subcategory,
      viscosity: row.viscosity,
    }
    // Only fully-specified products can prove a spread. A product missing an
    // attribute is an unknown, and counting unknowns as a distinct spec would
    // flag every canonical item that merely has incomplete data.
    const parts = (['category', 'application', 'subcategory', 'viscosity'] as const)
      .map((dimension) => specValue(item, dimension))
    if (parts.some((p) => p == null)) continue
    const key = parts.join('|')

    let entry = byCanonical.get(row.canonicalItemId)
    if (!entry) {
      entry = { name: row.canonicalItemName, specs: new Map() }
      byCanonical.set(row.canonicalItemId, entry)
    }
    let spec = entry.specs.get(key)
    if (!spec) {
      spec = {
        label: [
          row.category,
          row.application,
          row.subcategory,
          row.viscosity,
        ]
          .filter((v): v is string => v != null && v !== '')
          .join(' · '),
        names: [],
      }
      entry.specs.set(key, spec)
    }
    spec.names.push(row.productName)
  }

  const spreads: CanonicalSpread[] = []
  for (const [canonicalItemId, entry] of byCanonical) {
    if (entry.specs.size < 2) continue
    const specs = [...entry.specs.values()]
      .map((s) => ({
        label: s.label,
        productCount: s.names.length,
        exampleName: s.names[0],
      }))
      .sort((a, b) => b.productCount - a.productCount)
    spreads.push({
      canonicalItemId,
      canonicalItemName: entry.name,
      specs,
      productCount: specs.reduce((n, s) => n + s.productCount, 0),
    })
  }

  // Widest spreads first: those mix the most unlike things and so do the most
  // damage to grouped savings math.
  spreads.sort(
    (a, b) => b.specs.length - a.specs.length || b.productCount - a.productCount,
  )
  return spreads
}
