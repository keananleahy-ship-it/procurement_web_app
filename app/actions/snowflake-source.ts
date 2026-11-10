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
  volumeImportRows,
  volumeImports,
} from '@/lib/db/schema'
import { requireAdmin } from '@/lib/roles'
import { listSnowflakeColumns, querySnowflake } from '@/lib/snowflake'
import {
  type ColumnMap,
  EXCLUDE,
  type HierarchyRow,
  type PulledRow,
  SOURCE_FIELDS,
  type SiteRollup,
  buildHierarchyQuery,
  buildPullQuery,
  emptyRollup,
  mergePulledRows,
  parseTableName,
  periodLabel,
  resolveSite,
  rollupLocationIds,
  toStagedVolume,
  validateColumnMap,
} from '@/lib/snowflake-source'
import { buildMatchIndex, resolveMatch } from '@/lib/volume-match'

export type SourceMapping = {
  sourceTable: string
  columnMap: ColumnMap
  siteRollup: SiteRollup
  lookbackMonths: number
  lastPulledAt: string | null
}

export type SiteHierarchyEntry = {
  region: string | null
  businessUnit: string | null
  site: string
  lines: number
  qty: number
  lastDate: string | null
}

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
    siteRollup: { ...emptyRollup(), ...(row.siteRollup ?? {}) },
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
    const entries = rows.map((r) => ({
      region: r.region?.trim() || null,
      businessUnit: r.businessUnit?.trim() || null,
      site: r.site ?? '',
      lines: Number(r.lines) || 0,
      qty: Number(r.qty) || 0,
      lastDate: r.lastDate ? new Date(r.lastDate).toISOString().slice(0, 10) : null,
    }))
    return { ok: true, entries }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not read warehouses.') }
  }
}

const rollupTarget = z.union([z.number().int().positive(), z.literal(EXCLUDE)])
const rollupLevel = z.record(z.string().max(500), rollupTarget)

const mappingSchema = z.object({
  sourceTable: z.string().trim().min(1, 'Enter the view to read from.').max(800),
  columnMap: z.record(z.string(), z.string().max(255)),
  siteRollup: z.object({
    region: rollupLevel,
    businessUnit: rollupLevel,
    site: rollupLevel,
  }),
  lookbackMonths: z.number().int().min(1).max(36),
})

export async function saveSourceMapping(
  input: z.input<typeof mappingSchema>,
): Promise<Result<{ message: string }>> {
  await requireAdmin()
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

  await db
    .update(snowflakeConnection)
    .set({ sourceTable, columnMap, siteRollup, lookbackMonths })
    .where(eq(snowflakeConnection.id, 1))
  revalidatePath('/data-sources')
  return { ok: true, message: 'Mapping saved.' }
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
    pulled = await querySnowflake<PulledRow>(
      buildPullQuery({ table, map: mapping.columnMap }),
      [mapping.lookbackMonths],
    )
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Snowflake query failed.') }
  }

  const locRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(inArray(locations.id, rollupIds))
  const locName = new Map(locRows.map((l) => [l.id, l.name]))

  const [canon, prods] = await Promise.all([
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
  ])
  const matchIndex = buildMatchIndex(canon, prods)
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
    const staged = rows
      .map((r) => toStagedVolume(r, mapping.lookbackMonths))
      .filter((r) => r !== null)
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
      staged.map((r) => {
        const match = resolveMatch({ itemName: r.itemName, sku: r.sku }, matchIndex)
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
