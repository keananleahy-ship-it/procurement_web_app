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

// A single row's fields needed to roll it up to item level.
type AggregatableRow = {
  canonicalItemId: number | null
  productId: number | null
  annualVolume: string | null
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
}

type AggregatedVolume = {
  canonicalItemId: number | null
  productId: number | null
  annualVolume: string
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
  // How many detailed rows collapsed into this summary.
  sourceRowCount: number
}

// Roll detailed rows up to one summary per matched item + period. This is the
// core of turning line-item purchasing history into the SKU-level summary the
// rest of the app expects: quantities are SUMMED and the average unit cost is
// VOLUME-WEIGHTED across the detailed lines (so a big-volume, low-cost month
// dominates the blended baseline correctly). Cost weighting only counts volume
// that actually carries a cost, so rows with a blank cost don't drag the
// average toward zero. The grouping key deliberately matches
// replaceExistingImportedVolume's key (item + period, ignoring base unit) so a
// single delete+insert per group can't clobber a sibling group.
function aggregateVolumeRows(
  rows: AggregatableRow[],
  defaultPeriod: string | null,
): AggregatedVolume[] {
  const groups = new Map<
    string,
    {
      canonicalItemId: number | null
      productId: number | null
      period: string | null
      baseUnit: string | null
      totalVolume: number
      costWeightedNum: number
      costWeightedDen: number
      count: number
    }
  >()

  for (const r of rows) {
    const vol = Number(r.annualVolume)
    if (!Number.isFinite(vol) || vol <= 0) continue
    const period = r.period?.trim() || defaultPeriod || null
    // Key by BOTH canonical and product so that when a canonical-matched line
    // also carries a specific product (set by the product backfill), each
    // distinct product keeps its own summary row instead of collapsing to a
    // single canonical blend. This preserves per-product volume for the savings
    // engine's present-state pricing, matches replaceExistingImportedVolume's
    // (canonical, product, period) key, and is a no-op for legacy rows where
    // productId is null.
    const itemKey = `c:${r.canonicalItemId ?? ''}:p:${r.productId ?? ''}`
    const key = `${itemKey}|${period ?? ''}`

    let g = groups.get(key)
    if (!g) {
      g = {
        canonicalItemId: r.canonicalItemId,
        productId: r.productId,
        period,
        baseUnit: r.baseUnit,
        totalVolume: 0,
        costWeightedNum: 0,
        costWeightedDen: 0,
        count: 0,
      }
      groups.set(key, g)
    }

    g.totalVolume += vol
    if (!g.baseUnit && r.baseUnit) g.baseUnit = r.baseUnit
    const cost =
      r.baselineUnitCost !== null && r.baselineUnitCost !== ''
        ? Number(r.baselineUnitCost)
        : null
    if (cost !== null && Number.isFinite(cost)) {
      g.costWeightedNum += vol * cost
      g.costWeightedDen += vol
    }
    g.count++
  }

  return [...groups.values()].map((g) => ({
    canonicalItemId: g.canonicalItemId,
    productId: g.productId,
    annualVolume: g.totalVolume.toFixed(2),
    baseUnit: g.baseUnit,
    baselineUnitCost:
      g.costWeightedDen > 0
        ? (g.costWeightedNum / g.costWeightedDen).toFixed(4)
        : null,
    period: g.period,
    sourceRowCount: g.count,
  }))
}

// Filter a pending/committed import's staging rows down to the ones that can
// weight a comparison (included, matched+confirmed, positive quantity), and
// tally why the rest were dropped. Shared by the writer and the location
// reassign so both agree exactly on which rows contribute volume.
async function collectEligibleRows(volumeImportId: number): Promise<{
  eligible: AggregatableRow[]
  skipped: number
  unmatched: number
}> {
  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))

  let skipped = 0
  let unmatched = 0
  const eligible: AggregatableRow[] = []

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
    eligible.push({
      canonicalItemId: r.canonicalItemId,
      productId: r.productId,
      annualVolume: r.annualVolume,
      baseUnit: r.baseUnit,
      baselineUnitCost: r.baselineUnitCost,
      period: r.period,
    })
  }

  return { eligible, skipped, unmatched }
}

// Shared writer for both the initial commit and a re-sync: filter the staging
// rows down to the ones that can weight a comparison, roll them up to item
// level, and write one purchase_volumes row per item + period. Returns the
// standard tally, where `committed` is the number of summary volumes written.
async function writeVolumesFromRows(opts: {
  userId: string
  volumeImportId: number
  locationId: number
  defaultPeriod: string | null
}): Promise<CommitVolumeResult> {
  const { userId, volumeImportId, locationId, defaultPeriod } = opts

  const { eligible, skipped, unmatched } =
    await collectEligibleRows(volumeImportId)

  // Roll the detailed lines up to one summary per item + period before writing,
  // so several detailed entries for the same SKU sum into a single volume
  // instead of each delete+insert overwriting the last.
  const summaries = aggregateVolumeRows(eligible, defaultPeriod)

  for (const s of summaries) {
    await replaceExistingImportedVolume({
      userId,
      canonicalItemId: s.canonicalItemId,
      productId: s.productId,
      locationId,
      period: s.period,
    })
    await db.insert(purchaseVolumes).values({
      userId,
      canonicalItemId: s.canonicalItemId,
      productId: s.productId,
      locationId,
      annualVolume: s.annualVolume,
      baseUnit: s.baseUnit,
      baselineUnitCost: s.baselineUnitCost,
      period: s.period,
      source: 'import',
    })
  }

  return { committed: summaries.length, skipped, unmatched }
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

  const result = await writeVolumesFromRows({
    userId,
    volumeImportId,
    locationId,
    defaultPeriod: imp.defaultPeriod,
  })

  await db
    .update(volumeImports)
    .set({
      status: 'committed',
      committedAt: new Date(),
      rowCount: result.committed,
    })
    .where(eq(volumeImports.id, volumeImportId))

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
    const key = `${itemKey}|${period ?? ''}`
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
  for (const s of summaries) {
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
  })

  revalidatePath('/volumes')
  revalidatePath('/compare')
  revalidatePath('/')
  return { status: imp.status, locationName: loc.name, moved: result.committed }
}
