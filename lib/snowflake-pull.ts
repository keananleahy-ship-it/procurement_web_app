import 'server-only'

import { and, eq, inArray, or } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import {
  locations,
  products,
  snowflakeConnection,
  vendorPrices,
  volumeImportRows,
  volumeImports,
} from '@/lib/db/schema'
import { listSnowflakeColumns, querySnowflake } from '@/lib/snowflake'
import {
  type ColumnMap,
  type PullOptions,
  type PulledRow,
  type SiteRollup,
  buildPullQuery,
  mergePulledRows,
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

// The pull itself, free of session checks so both the admin's "Pull" button
// and the scheduled cron run share one implementation. Callers authorize.

export type SourceMapping = {
  sourceTable: string
  columnMap: ColumnMap
  siteRollup: SiteRollup
  pullOptions: PullOptions
  lookbackMonths: number
  lastPulledAt: string | null
}

export async function loadSourceMapping(): Promise<SourceMapping | null> {
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

type Result<T> = ({ ok: true } & T) | { ok: false; message: string }

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback
}

type ProdTarget = Parameters<typeof buildMatchIndex>[0][number]

// One match index per mapped app vendor, holding only the products on that
// vendor's price sheets, so a part number is resolved within its own vendor.
function buildVendorIndexes(
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
    [...byVendor].map(([vendorId, list]) => [vendorId, buildMatchIndex(list)]),
  )
}

// Part number first, vendor part number second:
//   0. a reviewer-confirmed crosswalk entry for (vendor, code) -> confirmed
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
  crosswalk: CrosswalkMap,
  prodName: Map<number, string>,
): { result: VolumeMatchResult; code: string | null } {
  const codes = [row.sku, row.vendorPartNumber]
  const linked = lookupCrosswalk(crosswalk, row.vendor, codes)
  if (linked && prodName.has(linked.productId)) {
    return {
      result: {
        canonicalItemId: null,
        productId: linked.productId,
        matchName: prodName.get(linked.productId) ?? null,
        matchStatus: 'confirmed',
        matchScore: 1,
      },
      code: linked.code,
    }
  }
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
// `ownerId` is the admin whose catalog, price sheets, and crosswalk are used.
export async function runSnowflakePull(
  ownerId: string,
): Promise<Result<{ imports: PullSummary[]; skipped: string[] }>> {
  const admin = { id: ownerId }
  const mapping = await loadSourceMapping()
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

  const [prods, priced] = await Promise.all([
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
  const matchIndex = buildMatchIndex(prods)
  const vendorIndex = buildVendorIndexes(
    prods,
    priced,
    new Set(Object.values(mapping.pullOptions.vendorMap)),
  )
  const prodName = new Map(prods.map((p) => [p.id, p.name]))

  // Reviewer picks on the pending pulls this one replaces. Any that a plain
  // code match wouldn't reproduce are saved to the crosswalk so a re-pull
  // never throws away review work. Rows a reviewer excluded stay excluded too,
  // which matters once scheduled pulls replace pending ones unattended.
  const stalePicks = new Map<string, number>()
  const staleExcluded = new Set<string>()
  const staleRows = await db
    .select({
      locationId: volumeImports.locationId,
      sku: volumeImportRows.sku,
      productId: volumeImportRows.productId,
      matchStatus: volumeImportRows.matchStatus,
      include: volumeImportRows.include,
    })
    .from(volumeImportRows)
    .innerJoin(volumeImports, eq(volumeImports.id, volumeImportRows.volumeImportId))
    .where(
      and(
        inArray(volumeImports.locationId, rollupIds),
        eq(volumeImports.fileType, 'snowflake'),
        eq(volumeImports.status, 'pending'),
        or(eq(volumeImportRows.matchStatus, 'confirmed'), eq(volumeImportRows.include, false)),
      ),
    )
  for (const s of staleRows) {
    if (!s.sku?.trim()) continue
    const key = `${s.locationId}|${normalizeSku(s.sku)}`
    if (!s.include) staleExcluded.add(key)
    if (s.matchStatus !== 'confirmed' || !s.productId || !prodName.has(s.productId)) continue
    stalePicks.set(key, s.productId)
  }
  const wasExcluded = (codes: (string | null | undefined)[], locationId: number) =>
    codes.some((c) => c?.trim() && staleExcluded.has(`${locationId}|${normalizeSku(c)}`))

  const crosswalk = await loadCrosswalk(admin.id)
  const carried: CrosswalkEntry[] = []
  const match = (
    r: PulledRow,
    staged: { itemName: string; sku: string | null },
    locationId: number,
  ) => {
    const m = matchPulledRow(
      r,
      staged,
      mapping.pullOptions.vendorMap,
      vendorIndex,
      matchIndex,
      crosswalk,
      prodName,
    )
    const pickCode = [r.sku, r.vendorPartNumber, staged.sku].find(
      (c) => c?.trim() && stalePicks.has(`${locationId}|${normalizeSku(c)}`),
    )
    const pick = pickCode ? stalePicks.get(`${locationId}|${normalizeSku(pickCode)}`) : undefined
    if (!pick || !pickCode) return m
    if (m.result.matchStatus === 'confirmed' && m.result.productId === pick) return m
    if (r.vendor?.trim()) carried.push({ vendor: r.vendor, code: pickCode, productId: pick })
    return {
      result: {
        canonicalItemId: null,
        productId: pick,
        matchName: prodName.get(pick) ?? null,
        matchStatus: 'confirmed' as const,
        matchScore: 1,
      },
      code: pickCode,
    }
  }
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
      const m = match(r, s, locationId)
      return [
        {
          ...s,
          sku: m.code ?? s.sku,
          sourceVendor: r.vendor?.trim() || null,
          match: m.result,
          include: !wasExcluded([r.sku, r.vendorPartNumber, s.sku, m.code], locationId),
        },
      ]
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
        }
      }),
    )
    imports.push({ volumeImportId: created.id, locationName: name, rowCount: staged.length, coverage })
  }

  await saveCrosswalk(admin.id, carried, admin.id)

  await db
    .update(snowflakeConnection)
    .set({ lastPulledAt: new Date() })
    .where(eq(snowflakeConnection.id, 1))
  revalidatePath('/volumes')
  revalidatePath('/data-sources')
  return { ok: true, imports, skipped }
}
