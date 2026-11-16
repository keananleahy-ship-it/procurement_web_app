'use server'

import { and, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
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
  normalizeSku,
  resolveMatch,
} from '@/lib/volume-match'
import {
  type CrosswalkEntry,
  type CrosswalkMap,
  loadCrosswalk,
  lookupCrosswalk,
  saveCrosswalk,
} from '@/lib/crosswalk'

import {
  type PullSummary as PullSummaryType,
  type SourceMapping as SourceMappingType,
  loadSourceMapping,
  runSnowflakePull,
} from '@/lib/snowflake-pull'

// A type alias, not `export type { }`: Turbopack treats re-exports in a
// 'use server' file as server action references and fails to resolve them.
export type SourceMapping = SourceMappingType

export type SiteHierarchyEntry = HierarchyEntry

type Result<T> = ({ ok: true } & T) | { ok: false; message: string }

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback
}

export async function getSourceMapping(): Promise<SourceMapping | null> {
  await requireAdmin()
  return loadSourceMapping()
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

export type PullSummary = PullSummaryType

export async function pullSnowflakeVolumes(): Promise<
  Result<{ imports: PullSummary[]; skipped: string[] }>
> {
  const admin = await requireAdmin()
  return runSnowflakePull(admin.id)
}
