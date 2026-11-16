import 'server-only'

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { products, purchaseVolumes, volumeImportRows, volumeImports } from '@/lib/db/schema'
import {
  type MatchIndex,
  buildMatchIndex,
  normalizeName,
  normalizeSku,
  resolveExactIdentity,
} from '@/lib/volume-match'
import { normalizeUom } from '@/lib/uom'
import { deriveAttributes } from '@/lib/attributes'

// Writing a reviewed volume import into purchase_volumes, free of session
// checks so the editor's Apply button and the scheduled Snowflake pull share
// one implementation. Callers authorize.

export type CommitVolumeResult = {
  committed: number
  skipped: number
  unmatched: number
  // Snowflake applies only: volumes removed at the location, and sign-offs
  // that carried to the same product or were dropped because it's gone.
  replaced?: number
  signoffsCarried?: number
  signoffsDropped?: number
}

// Delete any prior imported volume for the same item+location+period before
// inserting, so re-uploading a corrected sheet refreshes cleanly instead of
// double-counting. Only source='import' rows are touched — hand-entered
// ('manual') and synced ('snowflake') volumes are left alone.
export async function replaceExistingImportedVolume(opts: {
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
export type AggregatableRow = {
  canonicalItemId: number | null
  productId: number | null
  annualVolume: string | null
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
  lastUnitCost: string | null
  lastPurchaseDate: string | null
}

type AggregatedVolume = {
  canonicalItemId: number | null
  productId: number | null
  annualVolume: string
  baseUnit: string | null
  baselineUnitCost: string | null
  period: string | null
  lastUnitCost: string | null
  lastPurchaseDate: string | null
  // How many detailed rows collapsed into this summary.
  sourceRowCount: number
}

// Roll detailed rows up to one summary per matched item + period. This is the
// core of turning line-item purchasing history into the SKU-level summary the
// rest of the app expects: quantities are SUMMED and the average unit cost is
// VOLUME-WEIGHTED across the detailed lines (so a big-volume, low-cost month
// dominates the blended baseline correctly). Cost weighting only counts volume
// that actually carries a cost, so rows with a blank cost don't drag the
// average toward zero. The grouping key is item + period + NORMALIZED UNIT, so
// a SKU reported in both gallons and cases yields two honest summaries instead
// of one nonsensical blend. Because several summaries can now share an
// (item, period), the writer deletes existing imported volumes once per
// (item, period) — unit-agnostic — before inserting the per-unit rows, so a
// sibling unit's delete can't clobber a just-written row.
export function aggregateVolumeRows(
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
      lastUnitCost: string | null
      lastPurchaseDate: string | null
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
    // Key by BOTH item and NORMALIZED UNIT so incompatible units never blend
    // into one summary. Vendors report the same SKU in gallons AND in cases/
    // drums on separate lines; summing those quantities is meaningless and
    // volume-weighting a per-gallon price with a per-case price corrupts the
    // baseline. Splitting per unit keeps each summary's quantity and price
    // honest; the savings engine already sums multiple rows per product.
    const unit = normalizeUom(r.baseUnit)
    const itemKey = `c:${r.canonicalItemId ?? ''}:p:${r.productId ?? ''}`
    const key = `${itemKey}|${period ?? ''}|u:${unit}`

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
        lastUnitCost: null,
        lastPurchaseDate: null,
      }
      groups.set(key, g)
    }
    if (
      r.lastUnitCost !== null &&
      r.lastPurchaseDate &&
      (!g.lastPurchaseDate || r.lastPurchaseDate > g.lastPurchaseDate)
    ) {
      g.lastUnitCost = r.lastUnitCost
      g.lastPurchaseDate = r.lastPurchaseDate
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
    lastUnitCost: g.lastUnitCost,
    lastPurchaseDate: g.lastPurchaseDate,
    sourceRowCount: g.count,
  }))
}

// Resolve every included row to an AUTHORITATIVE product/canonical identity
// before the volumes are written, creating a standalone product for any row
// whose vendor code (or, for code-less rows, exact name) isn't already in the
// catalog. This is the core of the vendor-code-identity fix: each distinct
// vendor code becomes exactly one product, so distinct codes can never be
// merged onto one item by name similarity.
//
// Rules per included row with a usable quantity:
//   - Already `confirmed` with an id (an exact-code match from upload, or a
//     reviewer's manual pick) -> authoritative, left untouched.
//   - Otherwise re-resolve via resolveExactIdentity (exact code, else exact
//     name for code-less rows). A hit points the row at that product/canonical
//     and marks it confirmed. A miss auto-creates a standalone product keyed by
//     the row's own code (or name) and points the row at it.
// Fuzzy `suggested` rows therefore never borrow another item's identity; they
// get their own product unless a human explicitly confirmed the suggestion.
//
// Runs inside commit/resync/reprocess (all go through writeVolumesFromRows), so
// products are only ever created when an import is actually applied — never for
// a pending upload the user might discard. Returns how many products it created.
export async function ensureProductsForImport(
  volumeImportId: number,
  userId: string,
): Promise<{ created: number }> {
  const rows = await db
    .select()
    .from(volumeImportRows)
    .where(eq(volumeImportRows.volumeImportId, volumeImportId))

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
  const index: MatchIndex = buildMatchIndex(prods)

  // Identity key -> resolved ids, seeded as rows are handled so two rows with
  // the same code/name (or a code newly created earlier in this run) collapse
  // onto one product instead of creating duplicates.
  const resolved = new Map<
    string,
    { canonicalItemId: number | null; productId: number | null }
  >()

  const identityKey = (sku: string | null, itemName: string): string => {
    const code = sku?.trim() ? normalizeSku(sku) : ''
    if (code) return `code:${code}`
    return `name:${normalizeName(itemName)}`
  }

  let created = 0

  for (const r of rows) {
    if (!r.include) continue
    if (r.annualVolume === null || Number(r.annualVolume) <= 0) continue

    // Respect an authoritative match already on the row (exact code at upload
    // or a reviewer's manual pick). Never override a human decision or a
    // deterministic code hit.
    if (
      r.matchStatus === 'confirmed' &&
      (r.canonicalItemId !== null || r.productId !== null)
    ) {
      continue
    }

    const key = identityKey(r.sku, r.itemName)
    let target = resolved.get(key)

    if (!target) {
      const hit = resolveExactIdentity(
        { itemName: r.itemName, sku: r.sku ?? null },
        index,
      )
      if (hit) {
        target = {
          canonicalItemId:
            null,
          productId: hit.target.productId,
        }
      } else {
        // No exact identity in the catalog -> create a standalone product for
        // this vendor code (or name). Prefill derived attributes so it shows up
        // in Catalog Validation ready to review, and leave it canonical-
        // unmatched so cross-vendor grouping stays an explicit, reviewed step.
        const name = r.itemName.trim()
        const attrs = deriveAttributes(name)
        const [newProduct] = await db
          .insert(products)
          .values({
            userId,
            name,
            sku: r.sku?.trim() || null,
            baseUnit: r.baseUnit?.trim() || null,
            unit: r.baseUnit?.trim() || null,
            brand: attrs.brand,
            category: attrs.category,
            application: attrs.application,
            subcategory: attrs.subcategory,
            viscosity: attrs.viscosity,
            packageType: attrs.packageType,
            attributesEdited: false,
            canonicalItemId: null,
            matchStatus: 'unmatched',
          })
          .returning({ id: products.id })
        created++
        target = { canonicalItemId: null, productId: newProduct.id }
      }
      resolved.set(key, target)
    }

    await db
      .update(volumeImportRows)
      .set({
        canonicalItemId: target.canonicalItemId,
        productId: target.productId,
        matchStatus: 'confirmed',
        matchName: r.itemName.trim(),
      })
      .where(eq(volumeImportRows.id, r.id))
  }

  return { created }
}

// Filter a pending/committed import's staging rows down to the ones that can
// weight a comparison (included, matched+confirmed, positive quantity), and
// tally why the rest were dropped. Shared by the writer and the location
// reassign so both agree exactly on which rows contribute volume.
export async function collectEligibleRows(volumeImportId: number): Promise<{
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
    // weight a comparison. CONFIRMED ONLY: a fuzzy `suggested` guess never feeds
    // the baseline. By the time this runs at commit/resync/reprocess,
    // ensureProductsForImport has already turned every eligible row into a
    // confirmed match against its own vendor-code/name identity (creating a
    // product where needed), so confirmed-only drops nothing legitimate — it
    // only fences out un-applied fuzzy guesses.
    const hasMatch = r.canonicalItemId !== null || r.productId !== null
    const isConfirmed = r.matchStatus === 'confirmed'
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
      lastUnitCost: r.lastUnitCost,
      lastPurchaseDate: r.lastPurchaseDate,
    })
  }

  return { eligible, skipped, unmatched }
}

// Shared writer for both the initial commit and a re-sync: filter the staging
// rows down to the ones that can weight a comparison, roll them up to item
// level, and write one purchase_volumes row per item + period. Returns the
// standard tally, where `committed` is the number of summary volumes written.
export async function writeVolumesFromRows(opts: {
  userId: string
  volumeImportId: number
  locationId: number
  defaultPeriod: string | null
  fileType: string
}): Promise<CommitVolumeResult> {
  const { userId, volumeImportId, locationId, defaultPeriod, fileType } = opts

  if (fileType === 'snowflake') {
    return writeSnowflakeVolumes({ userId, volumeImportId, locationId, defaultPeriod })
  }

  const [snowflakeRow] = await db
    .select({ id: purchaseVolumes.id })
    .from(purchaseVolumes)
    .where(
      and(
        eq(purchaseVolumes.locationId, locationId),
        eq(purchaseVolumes.source, 'snowflake'),
      ),
    )
    .limit(1)
  if (snowflakeRow) {
    throw new Error(
      'This location now uses Snowflake purchasing data, so spreadsheet volumes would double count. Pull from Snowflake instead.',
    )
  }

  // Resolve/create authoritative product identities first, so every eligible
  // row is confirmed against exactly one vendor code (or exact name) before the
  // baseline is written. This is what guarantees distinct codes never blend.
  await ensureProductsForImport(volumeImportId, userId)

  const { eligible, skipped, unmatched } =
    await collectEligibleRows(volumeImportId)

  // Roll the detailed lines up to one summary per item + period before writing,
  // so several detailed entries for the same SKU sum into a single volume
  // instead of each delete+insert overwriting the last.
  const summaries = aggregateVolumeRows(eligible, defaultPeriod)

  // Delete existing imported volumes ONCE per (item, period) — unit-agnostic,
  // so it also clears any pre-split blended row from an earlier commit — then
  // insert one row per normalized unit.
  const replaced = new Set<string>()
  for (const s of summaries) {
    const groupKey = `c:${s.canonicalItemId ?? ''}:p:${s.productId ?? ''}|${s.period ?? ''}`
    if (!replaced.has(groupKey)) {
      await replaceExistingImportedVolume({
        userId,
        canonicalItemId: s.canonicalItemId,
        productId: s.productId,
        locationId,
        period: s.period,
      })
      replaced.add(groupKey)
    }
    await db.insert(purchaseVolumes).values({
      userId,
      canonicalItemId: s.canonicalItemId,
      productId: s.productId,
      locationId,
      annualVolume: s.annualVolume,
      baseUnit: s.baseUnit,
      baselineUnitCost: s.baselineUnitCost,
      period: s.period,
      lastUnitCost: s.lastUnitCost,
      lastPurchaseDate: s.lastPurchaseDate,
      source: 'import',
    })
  }

  return { committed: summaries.length, skipped, unmatched }
}

// Sign-offs confirm a product's catalog attributes at a site, so they follow
// the product (or the canonical item when no product is resolved).
function signoffKey(v: { canonicalItemId: number | null; productId: number | null }) {
  return v.productId !== null ? `p:${v.productId}` : `c:${v.canonicalItemId}`
}

// Applying a Snowflake pull replaces every spreadsheet and earlier Snowflake
// volume at the location in one step, so the two sources never double count.
// Hand-entered volumes are kept. Existing sign-offs carry over to the same
// product; anything new or changed lands unsigned for the champion to review.
async function writeSnowflakeVolumes(opts: {
  userId: string
  volumeImportId: number
  locationId: number
  defaultPeriod: string | null
}): Promise<CommitVolumeResult> {
  const { userId, volumeImportId, locationId, defaultPeriod } = opts
  await ensureProductsForImport(volumeImportId, userId)
  const { eligible, skipped, unmatched } = await collectEligibleRows(volumeImportId)
  const summaries = aggregateVolumeRows(eligible, defaultPeriod)

  const replaceable = and(
    eq(purchaseVolumes.locationId, locationId),
    inArray(purchaseVolumes.source, ['import', 'snowflake']),
  )
  const prior = await db
    .select({
      canonicalItemId: purchaseVolumes.canonicalItemId,
      productId: purchaseVolumes.productId,
      source: purchaseVolumes.source,
      validatedAt: purchaseVolumes.validatedAt,
      validatedByUserId: purchaseVolumes.validatedByUserId,
      validatedByName: purchaseVolumes.validatedByName,
    })
    .from(purchaseVolumes)
    .where(replaceable)

  const signoffs = new Map<
    string,
    { validatedAt: Date; validatedByUserId: string | null; validatedByName: string | null }
  >()
  for (const p of prior) {
    if (!p.validatedAt) continue
    const key = signoffKey(p)
    const current = signoffs.get(key)
    if (!current || current.validatedAt < p.validatedAt) {
      signoffs.set(key, {
        validatedAt: p.validatedAt,
        validatedByUserId: p.validatedByUserId,
        validatedByName: p.validatedByName,
      })
    }
  }

  await db.delete(purchaseVolumes).where(replaceable)

  let carried = 0
  if (summaries.length > 0) {
    await db.insert(purchaseVolumes).values(
      summaries.map((s) => {
        const signoff = signoffs.get(signoffKey(s))
        if (signoff) carried++
        return {
          userId,
          canonicalItemId: s.canonicalItemId,
          productId: s.productId,
          locationId,
          annualVolume: s.annualVolume,
          baseUnit: s.baseUnit,
      baselineUnitCost: s.baselineUnitCost,
      period: s.period,
      lastUnitCost: s.lastUnitCost,
      lastPurchaseDate: s.lastPurchaseDate,
      source: 'snowflake',
          ...signoff,
        }
      }),
    )
  }

  return {
    committed: summaries.length,
    skipped,
    unmatched,
    replaced: prior.length,
    signoffsCarried: carried,
    signoffsDropped: [...signoffs.keys()].filter(
      (k) => !summaries.some((s) => signoffKey(s) === k),
    ).length,
  }
}

// Apply a pending import: write its volumes and mark it committed.
export async function applyVolumeImport(
  volumeImportId: number,
  userId: string,
): Promise<CommitVolumeResult> {
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

  const result = await writeVolumesFromRows({
    userId,
    volumeImportId,
    locationId: imp.locationId,
    defaultPeriod: imp.defaultPeriod,
    fileType: imp.fileType,
  })

  await db
    .update(volumeImports)
    .set({ status: 'committed', committedAt: new Date(), rowCount: result.committed })
    .where(eq(volumeImports.id, volumeImportId))
  return result
}
