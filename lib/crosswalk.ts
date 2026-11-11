import { db } from '@/lib/db'
import { itemCrosswalk, products } from '@/lib/db/schema'
import { normalizeName, normalizeSku } from '@/lib/volume-match'
import { and, eq, inArray, sql } from 'drizzle-orm'

// A reviewer-confirmed link from a purchasing system's (vendor, item code) to a
// catalog product. Vendors' codes often differ between systems (Phillips66
// mnemonics in Snowflake vs material numbers on price sheets), so a code that
// can't match a catalog SKU is confirmed by hand once and reused every pull.

export type CrosswalkMap = Map<string, number>

export function crosswalkKey(vendor: string | null, code: string | null): string | null {
  const v = vendor?.trim() ? normalizeName(vendor) : ''
  const c = code?.trim() ? normalizeSku(code) : ''
  return v && c ? `${v}|${c}` : null
}

// Only entries whose product still exists, so a deleted product can't be
// resurrected as a match target.
export async function loadCrosswalk(userId: string): Promise<CrosswalkMap> {
  const rows = await db
    .select({
      vendorKey: itemCrosswalk.vendorKey,
      codeKey: itemCrosswalk.codeKey,
      productId: itemCrosswalk.productId,
    })
    .from(itemCrosswalk)
    .innerJoin(products, eq(products.id, itemCrosswalk.productId))
    .where(eq(itemCrosswalk.userId, userId))
  return new Map(rows.map((r) => [`${r.vendorKey}|${r.codeKey}`, r.productId]))
}

export function lookupCrosswalk(
  map: CrosswalkMap,
  vendor: string | null,
  codes: (string | null | undefined)[],
): { productId: number; code: string } | null {
  for (const code of codes) {
    if (!code?.trim()) continue
    const key = crosswalkKey(vendor, code)
    const productId = key ? map.get(key) : undefined
    if (productId) return { productId, code }
  }
  return null
}

export type CrosswalkEntry = {
  vendor: string
  code: string
  productId: number
}

export async function saveCrosswalk(
  userId: string,
  entries: CrosswalkEntry[],
  createdBy: string | null,
): Promise<number> {
  const unique = new Map<string, CrosswalkEntry & { vendorKey: string; codeKey: string }>()
  for (const e of entries) {
    const key = crosswalkKey(e.vendor, e.code)
    if (!key) continue
    const [vendorKey, codeKey] = key.split('|')
    unique.set(key, { ...e, vendorKey, codeKey })
  }
  if (unique.size === 0) return 0
  await db
    .insert(itemCrosswalk)
    .values(
      [...unique.values()].map((e) => ({
        userId,
        vendorKey: e.vendorKey,
        codeKey: e.codeKey,
        productId: e.productId,
        vendorLabel: e.vendor.trim(),
        code: e.code.trim(),
        createdBy,
      })),
    )
    .onConflictDoUpdate({
      target: [itemCrosswalk.userId, itemCrosswalk.vendorKey, itemCrosswalk.codeKey],
      set: {
        productId: sql`excluded."productId"`,
        createdBy: sql`excluded."createdBy"`,
        updatedAt: sql`now()`,
      },
    })
  return unique.size
}

export async function removeCrosswalk(
  userId: string,
  vendor: string | null,
  codes: (string | null)[],
): Promise<void> {
  const v = vendor?.trim() ? normalizeName(vendor) : ''
  const keys = codes.map((c) => (c?.trim() ? normalizeSku(c) : '')).filter(Boolean)
  if (!v || keys.length === 0) return
  await db
    .delete(itemCrosswalk)
    .where(
      and(
        eq(itemCrosswalk.userId, userId),
        eq(itemCrosswalk.vendorKey, v),
        inArray(itemCrosswalk.codeKey, keys),
      ),
    )
}
