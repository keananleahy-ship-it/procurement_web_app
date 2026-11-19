'use server'

import { db } from '@/lib/db'
import {
  volumeImports,
  volumeImportRows,
  purchaseVolumes,
  products,
  locations,
} from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import {
  buildMatchIndex,
  resolveMatch,
  resolveExactIdentity,
  normalizeSku,
  normalizeName,
  type MatchIndex,
} from '@/lib/volume-match'
import {
  loadCrosswalk,
  lookupCrosswalk,
  removeCrosswalk,
  saveCrosswalk,
} from '@/lib/crosswalk'
import {
  type CommitVolumeResult,
  aggregateVolumeRows,
  applyVolumeImport,
  collectEligibleRows,
  ensureProductsForImport,
  replaceExistingImportedVolume,
  writeVolumesFromRows,
} from '@/lib/volume-commit'
import { normalizeUom } from '@/lib/uom'
import { deriveAttributes } from '@/lib/attributes'
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

// The pickable match targets for the review dropdown: products only.
export async function getMatchTargets() {
  const { id: userId } = await requireUser()
  const prods = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, userId))
    .orderBy(products.name)
  return { products: prods }
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

  const prods = await db
      .select({
        id: products.id,
        name: products.name,
        category: products.category,
        sku: products.sku,
        canonicalItemId: products.canonicalItemId,
      })
      .from(products)
      .where(eq(products.userId, userId))
  const index = buildMatchIndex(prods)
  const prodName = new Map(prods.map((p) => [p.id, p.name]))
  const crosswalk = await loadCrosswalk(imp.userId)

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
    const linked = lookupCrosswalk(crosswalk, r.sourceVendor, [r.sku])
    const linkedName = linked ? prodName.get(linked.productId) : undefined
    const match =
      linked && linkedName
        ? {
            canonicalItemId: null,
            productId: linked.productId,
            matchName: linkedName,
            matchStatus: 'confirmed' as const,
            matchScore: 1,
          }
        : resolveMatch({ itemName: r.itemName, sku: r.sku }, index)
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

// Assign a row's product match; passing 'none' unmatches the row. Confirmed
// matches survive at commit; 'unmatched' rows are skipped.
export async function setVolumeRowMatch(
  rowId: number,
  target: { kind: 'product'; id: number; name: string } | { kind: 'none' },
) {
  const editor = await requireEditor()
  const [row] = await db
    .select({
      userId: volumeImportRows.userId,
      sku: volumeImportRows.sku,
      sourceVendor: volumeImportRows.sourceVendor,
    })
    .from(volumeImportRows)
    .where(eq(volumeImportRows.id, rowId))
  if (row?.sourceVendor && row.sku) {
    if (target.kind === 'none') {
      await removeCrosswalk(row.userId, row.sourceVendor, [row.sku])
    } else {
      await saveCrosswalk(
        row.userId,
        [{ vendor: row.sourceVendor, code: row.sku, productId: target.id }],
        editor.id,
      )
    }
  }
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
        canonicalItemId: null,
        productId: target.id,
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

  if (imp.blobPathname) {
    try {
      await del(imp.blobPathname)
    } catch (err) {
      console.error('blob delete failed:', err)
    }
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


export type SnowflakeReplacementPreview = {
  spreadsheetRows: number
  snowflakeRows: number
  signedOff: number
}

// What applying a Snowflake pull at this location would replace.
export async function getSnowflakeReplacementPreview(
  locationId: number,
): Promise<SnowflakeReplacementPreview> {
  await requireUser()
  const rows = await db
    .select({ source: purchaseVolumes.source, validatedAt: purchaseVolumes.validatedAt })
    .from(purchaseVolumes)
    .where(
      and(
        eq(purchaseVolumes.locationId, locationId),
        inArray(purchaseVolumes.source, ['import', 'snowflake']),
      ),
    )
  return {
    spreadsheetRows: rows.filter((r) => r.source === 'import').length,
    snowflakeRows: rows.filter((r) => r.source === 'snowflake').length,
    signedOff: rows.filter((r) => r.validatedAt).length,
  }
}

export async function commitVolumeImport(
  volumeImportId: number,
): Promise<CommitVolumeResult> {
  const { id: userId } = await requireEditor()
  const result = await applyVolumeImport(volumeImportId, userId)

  revalidatePath('/volumes')
  revalidatePath('/compare')
  revalidatePath('/')
  return result
}

// Re-push an already-committed import's current confirmed matches into
// purchase_volumes. After a commit, improving matches (e.g. via Re-match once
// the catalog gains SKUs) only updates the staging rows — the committed
// volumes that feed comparisons go stale, so newly-matched items never reach
// the savings engine. This re-runs the same write commitVolumeImport performs,
// without changing the import's status, so the comparison data catches up.
export async function resyncCommittedVolumeImport(
  volumeImportId: number,
): Promise<CommitVolumeResult> {
  const { id: userId } = await requireEditor()

  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')
  if (imp.status !== 'committed') {
    throw new Error('Only a committed volume import can be re-synced')
  }
  if (!imp.locationId) {
    throw new Error('This volume import has no location and cannot be synced')
  }
  const locationId = imp.locationId

  const result = await writeVolumesFromRows({
    userId,
    volumeImportId,
    locationId,
    defaultPeriod: imp.defaultPeriod,
    fileType: imp.fileType,
  })

  await db
    .update(volumeImports)
    .set({ rowCount: result.committed })
    .where(eq(volumeImports.id, volumeImportId))

  revalidatePath('/volumes')
  revalidatePath('/compare')
  revalidatePath('/')
  return result
}

export type RollupResult = {
  // Detailed rows removed by merging into a summary row.
  merged: number
  // Number of summary rows that absorbed at least one sibling.
  groups: number
  rows: (typeof volumeImportRows.$inferSelect)[]
}

// Collapse the detailed staging rows in place so the review table shows one
// summary row per matched item + period. This is the visible counterpart to
// the roll-up the writer applies at commit: several line-item entries for the
// same SKU (e.g. monthly transactions) become a single row with the summed
// quantity and the volume-weighted average unit cost, so the imported data
// lines up with previously entered summary volumes before it is applied.
//
// Only include+matched rows carrying a positive quantity are eligible;
// excluded, unmatched, or zero-quantity rows are left exactly as they are so a
// reviewer never loses data they still need to fix. Applied to a pending import
// only — a committed import's rows feed re-sync and are aggregated there.
export async function rollupVolumeImport(
  volumeImportId: number,
): Promise<RollupResult> {
  await requireEditor()

  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')
  if (imp.status === 'committed') {
    throw new Error('A committed volume import cannot be rolled up')
  }

  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))
    .orderBy(volumeImportRows.id)

  // Bucket eligible rows by item + period; everything else is untouched.
  const groups = new Map<string, (typeof rows)[number][]>()
  for (const r of rows) {
    const hasMatch = r.canonicalItemId !== null || r.productId !== null
    const eligible =
      r.include &&
      hasMatch &&
      r.annualVolume !== null &&
      Number(r.annualVolume) > 0
    if (!eligible) continue
    const period = r.period?.trim() || imp.defaultPeriod || null
    const itemKey =
      r.canonicalItemId !== null
        ? `c:${r.canonicalItemId}`
        : `p:${r.productId}`
    // Include normalized unit so the preview roll-up never merges gallons with
    // cases/drums into one line — mirrors aggregateVolumeRows at commit time.
    const key = `${itemKey}|${period ?? ''}|u:${normalizeUom(r.baseUnit)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }

  let merged = 0
  let mergedGroups = 0

  for (const bucket of groups.values()) {
    if (bucket.length <= 1) continue

    // Sum quantity and volume-weight the unit cost across the bucket.
    let totalVolume = 0
    let costWeightedNum = 0
    let costWeightedDen = 0
    let baseUnit: string | null = null
    for (const r of bucket) {
      const vol = Number(r.annualVolume)
      totalVolume += vol
      if (!baseUnit && r.baseUnit) baseUnit = r.baseUnit
      const cost =
        r.baselineUnitCost !== null && r.baselineUnitCost !== ''
          ? Number(r.baselineUnitCost)
          : null
      if (cost !== null && Number.isFinite(cost)) {
        costWeightedNum += vol * cost
        costWeightedDen += vol
      }
    }

    const keep = bucket[0]
    const removeIds = bucket.slice(1).map((r) => r.id)

    await db
      .update(volumeImportRows)
      .set({
        annualVolume: totalVolume.toFixed(2),
        baseUnit: baseUnit ?? keep.baseUnit,
        baselineUnitCost:
          costWeightedDen > 0
            ? (costWeightedNum / costWeightedDen).toFixed(4)
            : null,
      })
      .where(eq(volumeImportRows.id, keep.id))

    await db
      .delete(volumeImportRows)
      .where(inArray(volumeImportRows.id, removeIds))

    merged += removeIds.length
    mergedGroups++
  }

  const updatedRows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))
    .orderBy(volumeImportRows.id)

  revalidatePath('/volumes')
  return { merged, groups: mergedGroups, rows: updatedRows }
}

export type ReassignLocationResult = {
  status: string
  locationName: string
  // Number of committed volume summaries moved to the new location (0 for a
  // pending import, which has nothing committed yet).
  moved: number
}

// Correct the location a whole volume upload is attributed to. A volume import
// belongs to exactly ONE location, and every purchase_volumes row it writes is
// stamped with that location — so if the wrong location was picked at upload
// time, the committed volumes are weighting the wrong site's comparisons.
//
// For a PENDING import we only need to flip the stored location; nothing is
// committed yet. For a COMMITTED import we also relocate the data it already
// wrote: recompute this import's rolled-up summaries, delete them from the OLD
// location (source='import' only, so hand-entered/synced volumes are safe),
// then re-write them under the NEW location. Because deletion is keyed to this
// import's own item+period summaries, a co-located manual or other-import
// volume for a different item is left untouched.
export async function reassignVolumeImportLocation(
  volumeImportId: number,
  newLocationId: number,
): Promise<ReassignLocationResult> {
  const { id: userId } = await requireEditor()

  const [imp] = await db
    .select()
    .from(volumeImports)
    .where(eq(volumeImports.id, volumeImportId))
  if (!imp) throw new Error('Volume import not found')
  if (imp.status === 'discarded') {
    throw new Error('A discarded volume import cannot be reassigned')
  }
  if (imp.fileType === 'snowflake') {
    throw new Error(
      'Snowflake pulls get their location from the site mapping. Change it on Data sources and pull again.',
    )
  }

  // The target must be one of this user's locations.
  const [loc] = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.id, newLocationId), eq(locations.userId, userId)))
    .limit(1)
  if (!loc) throw new Error('Location not found')

  const oldLocationId = imp.locationId
  if (oldLocationId === newLocationId) {
    return { status: imp.status, locationName: loc.name, moved: 0 }
  }

  // Pending import: no committed volumes to move, just re-stamp the location.
  if (imp.status !== 'committed') {
    await db
      .update(volumeImports)
      .set({ locationId: newLocationId })
      .where(eq(volumeImports.id, volumeImportId))
    revalidatePath('/volumes')
    return { status: imp.status, locationName: loc.name, moved: 0 }
  }

  // Committed import: relocate the volumes it wrote. Compute the same rolled-up
  // summaries the writer produced, and delete each from the old location.
  const { eligible } = await collectEligibleRows(volumeImportId)
  const summaries = aggregateVolumeRows(eligible, imp.defaultPeriod)
  // Delete once per (item, period) — unit-agnostic — so the per-unit summaries
  // that now share an (item, period) don't each re-issue the same delete.
  const relocated = new Set<string>()
  for (const s of summaries) {
    const groupKey = `c:${s.canonicalItemId ?? ''}:p:${s.productId ?? ''}|${s.period ?? ''}`
    if (relocated.has(groupKey)) continue
    relocated.add(groupKey)
    await replaceExistingImportedVolume({
      userId,
      canonicalItemId: s.canonicalItemId,
      productId: s.productId,
      locationId: oldLocationId,
      period: s.period,
    })
  }

  // Re-stamp the import, then re-write its volumes under the new location.
  await db
    .update(volumeImports)
    .set({ locationId: newLocationId })
    .where(eq(volumeImports.id, volumeImportId))

  const result = await writeVolumesFromRows({
    userId,
    volumeImportId,
    locationId: newLocationId,
    defaultPeriod: imp.defaultPeriod,
    fileType: imp.fileType,
  })

  revalidatePath('/volumes')
  revalidatePath('/compare')
  revalidatePath('/')
  return { status: imp.status, locationName: loc.name, moved: result.committed }
}
