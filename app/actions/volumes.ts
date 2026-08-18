'use server'

import { db } from '@/lib/db'
import {
  volumeImports,
  volumeImportRows,
  purchaseVolumes,
  canonicalItems,
  products,
  locations,
} from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { buildMatchIndex, resolveMatch } from '@/lib/volume-match'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { del } from '@vercel/blob'
import { revalidatePath } from 'next/cache'

export async function getVolumeImports() {
  await requireUser()
  return db
    .select({
      id: volumeImports.id,
      fileName: volumeImports.fileName,
      fileType: volumeImports.fileType,
      blobPathname: volumeImports.blobPathname,
      locationId: volumeImports.locationId,
      locationName: locations.name,
      defaultPeriod: volumeImports.defaultPeriod,
      status: volumeImports.status,
      rowCount: volumeImports.rowCount,
      createdAt: volumeImports.createdAt,
      committedAt: volumeImports.committedAt,
    })
    .from(volumeImports)
    .leftJoin(locations, eq(volumeImports.locationId, locations.id))
    .orderBy(desc(volumeImports.createdAt))
}

export async function getVolumeImportWithRows(volumeImportId: number) {
  await requireUser()
  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) return null
  const [loc] = imp.locationId
    ? await db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.id, imp.locationId))
        .limit(1)
    : []
  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))
    .orderBy(volumeImportRows.id)
  return { import: imp, location: loc ?? null, rows }
}

// The pickable match targets for the review dropdown. Canonical items are
// listed first (and preferred) because volume attached to a canonical item
// applies to every vendor offer for that product; standalone products are the
// fallback for items that were never rolled up into a canonical item.
export async function getMatchTargets() {
  const { id: userId } = await requireUser()
  const [canon, prods] = await Promise.all([
    db
      .select({ id: canonicalItems.id, name: canonicalItems.name })
      .from(canonicalItems)
      .where(eq(canonicalItems.userId, userId))
      .orderBy(canonicalItems.name),
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.userId, userId))
      .orderBy(products.name),
  ])
  return {
    canonicalItems: canon,
    products: prods,
  }
}

export type RematchResult = {
  updated: number
  confirmed: number
  suggested: number
  unmatched: number
  rows: (typeof volumeImportRows.$inferSelect)[]
}

// Re-run auto-matching over a pending import's rows using the current catalog.
// Useful after the catalog gains SKUs or products (e.g. a new price import or a
// SKU backfill): rows that couldn't match before can now resolve. Rows a
// reviewer already confirmed by hand are left untouched — only auto-matched
// ('suggested') and 'unmatched' rows are recomputed.
export async function rematchVolumeImport(
  volumeImportId: number,
): Promise<RematchResult> {
  const { id: userId } = await requireEditor()

  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')
  if (imp.status === 'committed') {
    throw new Error('A committed volume import cannot be re-matched')
  }

  const [canon, prods] = await Promise.all([
    db
      .select({
        id: canonicalItems.id,
        name: canonicalItems.name,
        category: canonicalItems.category,
      })
      .from(canonicalItems)
      .where(eq(canonicalItems.userId, userId)),
    db
      .select({
        id: products.id,
        name: products.name,
        category: products.category,
        sku: products.sku,
        canonicalItemId: products.canonicalItemId,
      })
      .from(products)
      .where(eq(products.userId, userId)),
  ])
  const index = buildMatchIndex(canon, prods)

  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))

  const result: RematchResult = {
    updated: 0,
    confirmed: 0,
    suggested: 0,
    unmatched: 0,
    rows: [],
  }

  for (const r of rows) {
    // Preserve human decisions: only recompute rows still in an auto state.
    if (r.matchStatus === 'confirmed') {
      result.confirmed++
      continue
    }
    const match = resolveMatch({ itemName: r.itemName, sku: r.sku }, index)
    if (match.matchStatus === 'confirmed') result.confirmed++
    else if (match.matchStatus === 'suggested') result.suggested++
    else result.unmatched++

    const changed =
      match.canonicalItemId !== r.canonicalItemId ||
      match.productId !== r.productId ||
      match.matchStatus !== r.matchStatus
    if (!changed) continue

    await db
      .update(volumeImportRows)
      .set({
        canonicalItemId: match.canonicalItemId,
        productId: match.productId,
        matchName: match.matchName,
        matchStatus: match.matchStatus,
        matchScore:
          match.matchScore !== null ? match.matchScore.toFixed(4) : null,
      })
      .where(eq(volumeImportRows.id, r.id))
    result.updated++
  }

  result.rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))
    .orderBy(volumeImportRows.id)

  revalidatePath('/volumes')
  return result
}

type VolumeRowPatch = {
  itemName?: string
  annualVolume?: string | null
  baseUnit?: string | null
  baselineUnitCost?: string | null
  period?: string | null
  include?: boolean
}

export async function updateVolumeImportRow(
  rowId: number,
  patch: VolumeRowPatch,
) {
  await requireEditor()
  await db
    .update(volumeImportRows)
    .set(patch)
    .where(eq(volumeImportRows.id, rowId))
  revalidatePath('/volumes')
}

// Assign a row's match target. Passing kind 'canonical' or 'product' sets that
// id (and clears the other); passing 'none' unmatches the row. Confirmed
// matches survive at commit; 'unmatched' rows are skipped.
export async function setVolumeRowMatch(
  rowId: number,
  target:
    | { kind: 'canonical'; id: number; name: string }
    | { kind: 'product'; id: number; name: string }
    | { kind: 'none' },
) {
  await requireEditor()
  if (target.kind === 'none') {
    await db
      .update(volumeImportRows)
      .set({
        canonicalItemId: null,
        productId: null,
        matchName: null,
        matchStatus: 'unmatched',
      })
      .where(eq(volumeImportRows.id, rowId))
  } else {
    await db
      .update(volumeImportRows)
      .set({
        canonicalItemId: target.kind === 'canonical' ? target.id : null,
        productId: target.kind === 'product' ? target.id : null,
        matchName: target.name,
        matchStatus: 'confirmed',
      })
      .where(eq(volumeImportRows.id, rowId))
  }
  revalidatePath('/volumes')
}

export async function deleteVolumeImportRow(rowId: number) {
  await requireEditor()
  await db.delete(volumeImportRows).where(eq(volumeImportRows.id, rowId))
  revalidatePath('/volumes')
}

export async function discardVolumeImport(volumeImportId: number) {
  await requireEditor()
  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')

  try {
    await del(imp.blobPathname)
  } catch (err) {
    console.error('[v0] blob delete failed:', err)
  }
  await db
    .delete(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))
  await db
    .update(volumeImports)
    .set({ status: 'discarded' })
    .where(eq(volumeImports.id, volumeImportId))
  revalidatePath('/volumes')
}

export type CommitVolumeResult = {
  committed: number
  skipped: number
  unmatched: number
}

// Delete any prior imported volume for the same item+location+period before
// inserting, so re-uploading a corrected sheet refreshes cleanly instead of
// double-counting. Only source='import' rows are touched — hand-entered
// ('manual') and synced ('snowflake') volumes are left alone.
async function replaceExistingImportedVolume(opts: {
  userId: string
  canonicalItemId: number | null
  productId: number | null
  locationId: number
  period: string | null
}) {
  const { userId, canonicalItemId, productId, locationId, period } = opts
  const conds = [
    eq(purchaseVolumes.userId, userId),
    eq(purchaseVolumes.source, 'import'),
    eq(purchaseVolumes.locationId, locationId),
    canonicalItemId !== null
      ? eq(purchaseVolumes.canonicalItemId, canonicalItemId)
      : isNull(purchaseVolumes.canonicalItemId),
    productId !== null
      ? eq(purchaseVolumes.productId, productId)
      : isNull(purchaseVolumes.productId),
    period !== null
      ? eq(purchaseVolumes.period, period)
      : isNull(purchaseVolumes.period),
  ]
  await db.delete(purchaseVolumes).where(and(...conds))
}

export async function commitVolumeImport(
  volumeImportId: number,
): Promise<CommitVolumeResult> {
  const { id: userId } = await requireEditor()

  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')
  if (imp.status === 'committed') {
    throw new Error('This volume import has already been committed')
  }
  if (!imp.locationId) {
    throw new Error('This volume import has no location and cannot be committed')
  }
  const locationId = imp.locationId

  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))

  let committed = 0
  let skipped = 0
  let unmatched = 0

  for (const r of rows) {
    if (!r.include) {
      skipped++
      continue
    }
    // A row must resolve to an item and carry a usable quantity, or it can't
    // weight a comparison.
    const hasMatch = r.canonicalItemId !== null || r.productId !== null
    const isConfirmed =
      r.matchStatus === 'confirmed' || r.matchStatus === 'suggested'
    if (!hasMatch || !isConfirmed) {
      unmatched++
      continue
    }
    if (r.annualVolume === null || Number(r.annualVolume) <= 0) {
      skipped++
      continue
    }

    const period = r.period?.trim() || imp.defaultPeriod || null

    await replaceExistingImportedVolume({
      userId,
      canonicalItemId: r.canonicalItemId,
      productId: r.productId,
      locationId,
      period,
    })

    await db.insert(purchaseVolumes).values({
      userId,
      canonicalItemId: r.canonicalItemId,
      productId: r.productId,
      locationId,
      annualVolume: r.annualVolume,
      baseUnit: r.baseUnit,
      baselineUnitCost: r.baselineUnitCost,
      period,
      source: 'import',
    })
    committed++
  }

  await db
    .update(volumeImports)
    .set({
      status: 'committed',
      committedAt: new Date(),
      rowCount: committed,
    })
    .where(eq(volumeImports.id, volumeImportId))

  revalidatePath('/volumes')
  revalidatePath('/compare')
  revalidatePath('/')
  return { committed, skipped, unmatched }
}
