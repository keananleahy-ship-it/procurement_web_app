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
  type PulledRow,
  SOURCE_FIELDS,
  buildPullQuery,
  parseTableName,
  periodLabel,
  quoteColumn,
  toStagedVolume,
  validateColumnMap,
} from '@/lib/snowflake-source'
import { buildMatchIndex, resolveMatch } from '@/lib/volume-match'

export type SourceMapping = {
  sourceTable: string
  columnMap: ColumnMap
  siteMap: Record<string, number>
  lookbackMonths: number
  lastPulledAt: string | null
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
      siteMap: snowflakeConnection.siteMap,
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
    siteMap: row.siteMap ?? {},
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

// Distinct site values so each can be paired with an app location.
export async function loadSiteValues(
  table: string,
  siteColumn: string,
): Promise<Result<{ values: string[] }>> {
  await requireAdmin()
  try {
    const safeTable = parseTableName(table)
    const columns = await listSnowflakeColumns(safeTable)
    if (!columns.includes(siteColumn)) {
      return { ok: false, message: `Column ${siteColumn} is not in the view.` }
    }
    const site = quoteColumn(siteColumn)
    const rows = await querySnowflake<{ v: string }>(
      `select distinct to_varchar(${site}) as "v" from ${safeTable}
       where ${site} is not null order by 1 limit 500`,
    )
    return { ok: true, values: rows.map((r) => r.v) }
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Could not read site values.') }
  }
}

const mappingSchema = z.object({
  sourceTable: z.string().trim().min(1, 'Enter the view to read from.').max(800),
  columnMap: z.record(z.string(), z.string().max(255)),
  siteMap: z.record(z.string().max(500), z.number().int().positive()),
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
  const { sourceTable, siteMap, lookbackMonths } = parsed.data
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

  const locIds = [...new Set(Object.values(siteMap))]
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
    .set({ sourceTable, columnMap, siteMap, lookbackMonths })
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
  const siteEntries = Object.entries(mapping.siteMap)
  if (siteEntries.length === 0) {
    return { ok: false, message: 'Map at least one site value to a location.' }
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
      buildPullQuery({ table, map: mapping.columnMap, siteCount: siteEntries.length }),
      [...siteEntries.map(([site]) => site), mapping.lookbackMonths],
    )
  } catch (err) {
    return { ok: false, message: errorMessage(err, 'Snowflake query failed.') }
  }

  const locRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(inArray(locations.id, [...new Set(siteEntries.map(([, id]) => id))]))
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

  // Several site values can point at one location; group by location.
  const byLocation = new Map<number, PulledRow[]>()
  for (const row of pulled) {
    const locationId = mapping.siteMap[row.site]
    if (!locationId || !locName.has(locationId)) continue
    const list = byLocation.get(locationId) ?? []
    list.push(row)
    byLocation.set(locationId, list)
  }

  const imports: PullSummary[] = []
  const skipped: string[] = []
  for (const [locationId, name] of locName) {
    const rows = byLocation.get(locationId) ?? []
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
