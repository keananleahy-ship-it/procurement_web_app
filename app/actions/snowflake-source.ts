'use server'

import { and, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  canonicalItems,
  locations,
  products,
  snowflakeConnection,
  vendorPrices,
  vendors,
  volumeImportRows,
  volumeImports,
} from '@/lib/db/schema'
import { requireAdmin } from '@/lib/roles'
import { listSnowflakeColumns, querySnowflake } from '@/lib/snowflake'
import {
  type ColumnMap,
  EXCLUDE,
  type FacetRow,
  type HierarchyRow,
  type PullOptions,
  type PulledRow,
  SOURCE_FIELDS,
  type SiteRollup,
  buildFacetQuery,
  buildHierarchyQuery,
  buildPullQuery,
  type HierarchyEntry,
  mergePulledRows,
  mergeSiteVariants,
  normalizeName,
  normalizePullOptions,
  normalizeRollup,
  parseTableName,
  periodLabel,
  resolveSite,
  rollupLocationIds,
  toStagedVolume,
  validateColumnMap,
} from '@/lib/snowflake-source'
import {
  type MatchIndex,
  type VolumeMatchResult,
  buildMatchIndex,
  matchByCode,
  resolveMatch,
} from '@/lib/volume-match'

export type SourceMapping = {
  sourceTable: string
  columnMap: ColumnMap
  siteRollup: SiteRollup
  pullOptions: PullOptions
  lookbackMonths: number
  lastPulledAt: string | null
}

export type SiteHierarchyEntry = HierarchyEntry

type Result<T> = ({ ok: true } & T) | { ok: false; message: string }

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback
}

export async function getSourceMapping(): Promise<SourceMapping | null> {
  await requireAdmin()
  const [row] = await db
    .select({
      sourceTable: snowflakeConnection.sourceTable,
      columnMap: snowflakeConnection.columnMap,
      siteRollup: snowflakeConnection.siteRollup,
      pullOptions: snowflakeConnection.pullOptions,
      lookbackMonths: snowflakeConnection.lookbackMonths,
      lastPulledAt: snowflakeConnection.lastPulledAt,
    })
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)
  if (!row) return null
  return {
    sourceTable: row.sourceTable ?? '',
    columnMap: (row.columnMap ?? {}) as ColumnMap,
    siteRollup: normalizeRollup(row.siteRollup),
    pullOptions: normalizePullOptions(row.pullOptions),
    lookbackMonths: row.lookbackMonths,
    lastPulledAt: row.lastPulledAt?.toISOString() ?? null,
  }
}

export async function loadSourceColumns(
  table: string,
): Promise<Result<{ columns: string[] }>> {
  await requireAdmin()
  try {
    const columns = await listSnowflakeColumns(parseTableName(table))
    return { ok: true, columns }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not read the view.') }
  }
}

// Every region / business unit / warehouse combination with its volume over
// the window, so each can be rolled up to a platform location.
export async function loadSiteHierarchy(input: {
  table: string
  columnMap: ColumnMap
  lookbackMonths: number
}): Promise<Result<{ entries: SiteHierarchyEntry[] }>> {
  await requireAdmin()
  try {
    const table = parseTableName(input.table)
    const problem = validateColumnMap(input.columnMap, await listSnowflakeColumns(table))
    if (problem) return { ok: false, message: problem }
    const months = Math.min(36, Math.max(1, Math.trunc(input.lookbackMonths) || 12))
    const rows = await querySnowflake<HierarchyRow>(
      buildHierarchyQuery({ table, map: input.columnMap }),
      [months, months],
    )
    const entries = mergeSiteVariants(
      rows.map((r) => ({
        region: r.region?.trim() || null,
        businessUnit: r.businessUnit?.trim() || null,
        site: r.site ?? '',
        lines: Number(r.lines) || 0,
        qty: Number(r.qty) || 0,
        lastDate: r.lastDate ? new Date(r.lastDate).toISOString().slice(0, 10) : null,
      })),
    )
    return { ok: true, entries }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not read warehouses.') }
  }
}

export type Facet = { key: string; label: string; lines: number; qty: number }

// Folds case/punctuation variants of one value into a single entry, labelled
// with its most common spelling.
function mergeFacet(rows: FacetRow[]): Facet[] {
  const byKey = new Map<string, Facet & { best: number }>()
  for (const r of rows) {
    const label = r.value?.trim() ?? ''
    const key = normalizeName(label)
    if (!key) continue
    const lines = Number(r.lines) || 0
    const qty = Number(r.qty) || 0
    const cur = byKey.get(key)
    if (!cur) byKey.set(key, { key, label, lines, qty, best: lines })
    else {
      if (lines > cur.best) Object.assign(cur, { label, best: lines })
      cur.lines += lines
      cur.qty += qty
    }
  }
  return [...byKey.values()]
    .map(({ best: _best, ...f }) => f)
    .sort((a, b) => b.qty - a.qty)
}

// Product categories and vendors present in the view over the window, plus
// the app's vendors, for the category filter and vendor map.
export async function loadPullFacets(input: {
  table: string
  columnMap: ColumnMap
  lookbackMonths: number
  excludedCategories: string[]
}): Promise<
  Result<{
    categories: Facet[]
    vendors: Facet[]
    appVendors: { id: number; name: string }[]
  }>
> {
  const admin = await requireAdmin()
  try {
    const table = parseTableName(input.table)
    const problem = validateColumnMap(input.columnMap, await listSnowflakeColumns(table))
    if (problem) return { ok: false, message: problem }
    const months = Math.min(36, Math.max(1, Math.trunc(input.lookbackMonths) || 12))
    const excludedCategories = normalizePullOptions({
      excludedCategories: input.excludedCategories,
    }).excludedCategories
    const run = async (facet: 'category' | 'vendor') => {
      const q = buildFacetQuery({ table, map: input.columnMap, facet, excludedCategories })
      return q ? mergeFacet(await querySnowflake<FacetRow>(q.sql, [months, ...q.binds])) : []
    }
    const [categories, vendorFacets, appVendors] = await Promise.all([
      run('category'),
      run('vendor'),
      db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(eq(vendors.userId, admin.id))
        .orderBy(vendors.name),
    ])
    return { ok: true, categories, vendors: vendorFacets, appVendors }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not read categories and vendors.') }
  }
}

const rollupTarget = z.union([z.number().int().positive(), z.literal(EXCLUDE)])
const rollupLevel = z.record(z.string().max(500), rollupTarget)

const mappingSchema = z.object({
  sourceTable: z.string().trim().min(1, 'Enter the view to read from.').max(800),
  columnMap: z.record(z.string(), z.string().max(255)),
  siteRollup: z.object({
    region: rollupLevel,
    group: rollupLevel.default({}),
    businessUnit: rollupLevel,
    site: rollupLevel,
    groups: z
      .record(z.string().trim().min(1).max(100), z.array(z.string().max(500)).max(200))
      .default({})
      .refine((g) => Object.keys(g).length <= 50, 'Too many platform groups.'),
  }),
  pullOptions: z
    .object({
      excludedCategories: z.array(z.string().max(200)).max(200).default([]),
      vendorMap: z.record(z.string().max(300), z.number().int().positive()).default({}),
    })
    .default({ excludedCategories: [], vendorMap: {} }),
  lookbackMonths: z.number().int().min(1).max(36),
})

export async function saveSourceMapping(
  input: z.input<typeof mappingSchema>,
): Promise<Result<{ message: string }>> {
  const admin = await requireAdmin()
  const parsed = mappingSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid mapping.' }
  }
  const { sourceTable, siteRollup, lookbackMonths } = parsed.data
  const allowed = new Set<string>(SOURCE_FIELDS.map((f) => f.key))
  const columnMap: ColumnMap = Object.fromEntries(
    Object.entries(parsed.data.columnMap).filter(([k, v]) => allowed.has(k) && v),
  )

  try {
    const table = parseTableName(sourceTable)
    const problem = validateColumnMap(columnMap, await listSnowflakeColumns(table))
    if (problem) return { ok: false, message: problem }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not verify the view.') }
  }

  const locIds = rollupLocationIds(siteRollup)
  if (locIds.length > 0) {
    const found = await db
      .select({ id: locations.id })
      .from(locations)
      .where(inArray(locations.id, locIds))
    if (found.length !== locIds.length) {
      return { ok: false, message: 'One of the chosen locations no longer exists.' }
    }
  }

  const pullOptions = normalizePullOptions(parsed.data.pullOptions)
  const vendorIds = [...new Set(Object.values(pullOptions.vendorMap))]
  if (vendorIds.length > 0) {
    const found = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.userId, admin.id), inArray(vendors.id, vendorIds)))
    if (found.length !== vendorIds.length) {
      return { ok: false, message: 'One of the chosen vendors no longer exists.' }
    }
  }

  await db
    .update(snowflakeConnection)
    .set({ sourceTable, columnMap, siteRollup, pullOptions, lookbackMonths })
    .where(eq(snowflakeConnection.id, 1))
  revalidatePath('/data-sources')
  return { ok: true, message: 'Mapping saved.' }
}

type CanonTarget = Parameters<typeof buildMatchIndex>[0][number]
type ProdTarget = Parameters<typeof buildMatchIndex>[1][number]

// One match index per mapped app vendor, holding only the products on that
// vendor's price sheets, so a part number is resolved within its own vendor.
function buildVendorIndexes(
  canon: CanonTarget[],
  prods: ProdTarget[],
  priced: { productId: number; vendorId: number }[],
  vendorIds: Set<number>,
): Map<number, MatchIndex> {
  const prodById = new Map(prods.map((p) => [p.id, p]))
  const byVendor = new Map<number, ProdTarget[]>()
  for (const { productId, vendorId } of priced) {
    const p = prodById.get(productId)
    if (!p || !vendorIds.has(vendorId)) continue
    const list = byVendor.get(vendorId) ?? []
    list.push(p)
    byVendor.set(vendorId, list)
  }
  return new Map(
    [...byVendor].map(([vendorId, list]) => [vendorId, buildMatchIndex(canon, list)]),
  )
}

// Part number first, vendor part number second:
//   1. code on the mapped vendor's own sheets -> confirmed
//   2. code on another vendor's sheets -> confirmed if the row's vendor isn't
//      mapped; if it is, only suggested, since it may be a cross-vendor
//      collision (the reviewer decides)
//   3. otherwise the usual item-name / fuzzy suggestion
// Returns the code that matched so re-matching later reproduces it.
function matchPulledRow(
  row: PulledRow,
  staged: { itemName: string; sku: string | null },
  vendorMap: Record<string, number>,
  vendorIndex: Map<number, MatchIndex>,
  globalIndex: MatchIndex,
): { result: VolumeMatchResult; code: string | null } {
  const codes = [row.sku, row.vendorPartNumber]
  const vendorId = vendorMap[normalizeName(row.vendor)]
  const own = vendorId ? vendorIndex.get(vendorId) : undefined
  const ownHit = own ? matchByCode(codes, own) : null
  if (ownHit) return { result: ownHit.result, code: ownHit.code }

  const anyHit = matchByCode(codes, globalIndex)
  if (anyHit && !vendorId) return { result: anyHit.result, code: anyHit.code }
  if (anyHit) {
    return {
      result: {
        canonicalItemId: null,
        productId: null,
        matchName: anyHit.result.matchName,
        matchStatus: 'suggested',
        matchScore: 0.9,
      },
      code: anyHit.code,
    }
  }
  return { result: resolveMatch(staged, globalIndex), code: null }
}

export type PullSummary = {
  volumeImportId: number
  locationName: string
  rowCount: number
  coverage: string
}

// Reads the mapped view and stages one pending volume import per location.
// Nothing reaches purchase volumes until someone reviews and applies it.
export async function pullSnowflakeVolumes(): Promise<
  Result<{ imports: PullSummary[]; skipped: string[] }>
> {
  const admin = await requireAdmin()
  const mapping = await getSourceMapping()
  if (!mapping?.sourceTable) {
    return { ok: false, message: 'Save a source mapping first.' }
  }
  const rollupIds = rollupLocationIds(mapping.siteRollup)
  if (rollupIds.length === 0) {
    return { ok: false, message: 'Roll at least one warehouse up to a location.' }
  }

  let pulled: PulledRow[]
  try {
    const table = parseTableName(mapping.sourceTable)
    const problem = validateColumnMap(
      mapping.columnMap,
      await listSnowflakeColumns(table),
    )
    if (problem) return { ok: false, message: problem }
    const q = buildPullQuery({
      table,
      map: mapping.columnMap,
      lookbackMonths: mapping.lookbackMonths,
      excludedCategories: mapping.pullOptions.excludedCategories,
    })
    pulled = await querySnowflake<PulledRow>(q.sql, q.binds)
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Snowflake query failed.') }
  }

  const locRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(inArray(locations.id, rollupIds))
  const locName = new Map(locRows.map((l) => [l.id, l.name]))

  const [canon, prods, priced] = await Promise.all([
    db
      .select({
        id: canonicalItems.id,
        name: canonicalItems.name,
        category: canonicalItems.category,
      })
      .from(canonicalItems)
      .where(eq(canonicalItems.userId, admin.id)),
    db
      .select({
        id: products.id,
        name: products.name,
        category: products.category,
        sku: products.sku,
        canonicalItemId: products.canonicalItemId,
      })
      .from(products)
      .where(eq(products.userId, admin.id)),
    db
      .selectDistinct({ productId: vendorPrices.productId, vendorId: vendorPrices.vendorId })
      .from(vendorPrices)
      .where(eq(vendorPrices.userId, admin.id)),
  ])
  const matchIndex = buildMatchIndex(canon, prods)
  const vendorIndex = buildVendorIndexes(
    canon,
    prods,
    priced,
    new Set(Object.values(mapping.pullOptions.vendorMap)),
  )
  const match = (r: PulledRow, staged: { itemName: string; sku: string | null }) =>
    matchPulledRow(r, staged, mapping.pullOptions.vendorMap, vendorIndex, matchIndex)
  const period = periodLabel(mapping.lookbackMonths)
  const table = mapping.sourceTable

  // Many warehouses roll up to one location; group by the resolved location.
  const byLocation = new Map<number, PulledRow[]>()
  for (const row of pulled) {
    const { target } = resolveSite(
      {
        region: row.region?.trim() || null,
        businessUnit: row.businessUnit?.trim() || null,
        site: row.site ?? '',
      },
      mapping.siteRollup,
    )
    if (typeof target !== 'number' || !locName.has(target)) continue
    const list = byLocation.get(target) ?? []
    list.push(row)
    byLocation.set(target, list)
  }

  const imports: PullSummary[] = []
  const skipped: string[] = []
  for (const [locationId, name] of locName) {
    const rows = mergePulledRows(byLocation.get(locationId) ?? [])
    const staged = rows.flatMap((r) => {
      const s = toStagedVolume(r, mapping.lookbackMonths)
      if (!s) return []
      const m = match(r, s)
      return [{ ...s, sku: m.code ?? s.sku, match: m.result }]
    })
    if (staged.length === 0) {
      skipped.push(name)
      continue
    }

    const dates = rows.flatMap((r) => [r.firstDate, r.lastDate]).filter(Boolean)
    const times = dates.map((d) => new Date(d as string).getTime()).filter(Number.isFinite)
    const fmt = (t: number) => new Date(t).toISOString().slice(0, 10)
    const coverage =
      times.length > 0
        ? `${fmt(Math.min(...times))} to ${fmt(Math.max(...times))}`
        : 'unknown dates'
    const lines = rows.reduce((n, r) => n + Number(r.lines || 0), 0)

    // Replace any earlier unreviewed pull for this location.
    const stale = await db
      .select({ id: volumeImports.id })
      .from(volumeImports)
      .where(
        and(
          eq(volumeImports.locationId, locationId),
          eq(volumeImports.fileType, 'snowflake'),
          eq(volumeImports.status, 'pending'),
        ),
      )
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id)
      await db.delete(volumeImportRows).where(inArray(volumeImportRows.volumeImportId, ids))
      await db.delete(volumeImports).where(inArray(volumeImports.id, ids))
    }

    const [created] = await db
      .insert(volumeImports)
      .values({
        userId: admin.id,
        locationId,
        fileName: `Snowflake · ${table}`,
        blobPathname: '',
        fileType: 'snowflake',
        defaultPeriod: period,
        status: 'pending',
        rowCount: staged.length,
        note: `${lines.toLocaleString()} purchase lines from ${coverage}, last ${mapping.lookbackMonths} months${mapping.lookbackMonths === 12 ? '' : ', annualized'}.`,
      })
      .returning({ id: volumeImports.id })

    await db.insert(volumeImportRows).values(
      staged.map(({ match, ...r }) => {
        return {
          userId: admin.id,
          volumeImportId: created.id,
          ...r,
          period,
          canonicalItemId: match.canonicalItemId,
          productId: match.productId,
          matchName: match.matchName,
          matchStatus: match.matchStatus,
          matchScore: match.matchScore !== null ? match.matchScore.toFixed(4) : null,
          include: true,
        }
      }),
    )
    imports.push({ volumeImportId: created.id, locationName: name, rowCount: staged.length, coverage })
  }

  await db
    .update(snowflakeConnection)
    .set({ lastPulledAt: new Date() })
    .where(eq(snowflakeConnection.id, 1))
  revalidatePath('/volumes')
  revalidatePath('/data-sources')
  return { ok: true, imports, skipped }
}
