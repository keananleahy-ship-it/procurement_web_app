import * as XLSX from 'xlsx'
import { and, eq, getTableColumns, isNotNull, ne, type Column } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '@/lib/db'
import {
  products,
  canonicalItems,
  vendors,
  locations,
  vendorPrices,
  purchaseVolumes,
  volumeImports,
  volumeImportRows,
} from '@/lib/db/schema'
import { getCurrentUser } from '@/lib/roles'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// `userId` is the internal owner of a row in the shared workspace, not a
// business attribute, so it is left out of an integration-mapping export.
const OMIT = new Set(['userId'])

type Sheet = { name: string; table: PgTable; description: string }

const SHEETS: Sheet[] = [
  {
    name: 'Products',
    table: products,
    description:
      'Vendor-specific items. canonicalItemId -> Canonical Items.id (only meaningful when matchStatus = confirmed).',
  },
  {
    name: 'Canonical Items',
    table: canonicalItems,
    description: 'Vendor-neutral items that products are matched to for cross-vendor comparison.',
  },
  {
    name: 'Vendors',
    table: vendors,
    description: 'Suppliers that quote prices.',
  },
  {
    name: 'Locations',
    table: locations,
    description: 'Sites that receive pricing and record purchase volume.',
  },
  {
    name: 'Vendor Prices',
    table: vendorPrices,
    description:
      'Price quotes. productId -> Products.id, vendorId -> Vendors.id, locationId -> Locations.id.',
  },
  {
    name: 'Purchase Volumes',
    table: purchaseVolumes,
    description:
      'Annual volume per item/location in base units. canonicalItemId -> Canonical Items.id, productId -> Products.id, locationId -> Locations.id.',
  },
]

function exportColumns(table: PgTable) {
  return Object.entries(getTableColumns(table)).filter(([key]) => !OMIT.has(key)) as [
    string,
    Column,
  ][]
}

function toCell(value: unknown) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

export async function GET() {
  const current = await getCurrentUser()
  if (!current) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results = await Promise.all(
    SHEETS.map(async (sheet) => {
      const cols = exportColumns(sheet.table)
      const idCol = getTableColumns(sheet.table).id
      const rows = await db
        .select(Object.fromEntries(cols) as Record<string, PgColumn>)
        .from(sheet.table)
        .orderBy(idCol)
      return { sheet, cols, rows: rows as Record<string, unknown>[] }
    }),
  )

  const [locationRows, pricedRows, locationSkuRows] = await Promise.all([
    db.select({ id: locations.id, name: locations.name }).from(locations).orderBy(locations.id),
    db.selectDistinct({ productId: vendorPrices.productId }).from(vendorPrices),
    db
      .select({
        locationId: volumeImports.locationId,
        sku: volumeImportRows.sku,
        itemName: volumeImportRows.itemName,
        productId: volumeImportRows.productId,
        canonicalItemId: volumeImportRows.canonicalItemId,
        fileName: volumeImports.fileName,
        volumeImportId: volumeImports.id,
      })
      .from(volumeImportRows)
      .innerJoin(volumeImports, eq(volumeImports.id, volumeImportRows.volumeImportId))
      .where(
        and(
          eq(volumeImports.status, 'committed'),
          eq(volumeImportRows.include, true),
          eq(volumeImportRows.matchStatus, 'confirmed'),
          isNotNull(volumeImportRows.sku),
          ne(volumeImportRows.sku, ''),
        ),
      )
      .orderBy(volumeImports.locationId, volumeImportRows.sku),
  ])

  const locationName = new Map(locationRows.map((l) => [l.id, l.name]))
  const pricedProductIds = new Set(pricedRows.map((r) => r.productId))
  const locationSkuColumn = (id: number) => `locationSku_${locationName.get(id) ?? id}`
  const locationSkuColumns = locationRows.map((l) => locationSkuColumn(l.id))

  // "productId:3" / "canonical:12" -> locationId -> distinct SKUs
  const skusByTarget = new Map<string, Map<number, Set<string>>>()
  for (const row of locationSkuRows) {
    const sku = row.sku?.trim()
    if (!sku) continue
    const key =
      row.productId != null
        ? `product:${row.productId}`
        : row.canonicalItemId != null
          ? `canonical:${row.canonicalItemId}`
          : null
    if (!key) continue
    const byLocation = skusByTarget.get(key) ?? new Map<number, Set<string>>()
    const set = byLocation.get(row.locationId) ?? new Set<string>()
    set.add(sku)
    byLocation.set(row.locationId, set)
    skusByTarget.set(key, byLocation)
  }

  const locationSkuCells = (key: string) => {
    const byLocation = skusByTarget.get(key)
    return Object.fromEntries(
      locationRows.map((l) => {
        const set = byLocation?.get(l.id)
        return [locationSkuColumn(l.id), set ? [...set].join(' | ') : null]
      }),
    )
  }

  for (const result of results) {
    if (result.sheet.table === products) {
      result.rows = result.rows.map((r) => {
        const sku = typeof r.sku === 'string' ? r.sku.trim() : ''
        return {
          ...r,
          vendorSku: sku && pricedProductIds.has(r.id as number) ? sku : null,
          ...locationSkuCells(`product:${r.id}`),
        }
      })
    } else if (result.sheet.table === canonicalItems) {
      result.rows = result.rows.map((r) => ({ ...r, ...locationSkuCells(`canonical:${r.id}`) }))
    }
  }

  const derivedColumns = new Map<PgTable, { key: string; note: string }[]>([
    [
      products,
      [
        {
          key: 'vendorSku',
          note: 'Vendor part number. Equals `sku` when the product has at least one vendor price; null for products created only from a location purchase-history upload (their `sku` is that location\u2019s internal code, not a vendor SKU).',
        },
        ...locationSkuColumns.map((key) => ({
          key,
          note: 'Internal SKU this location uses for the product, from committed purchase-history uploads. Multiple codes are joined with " | ".',
        })),
      ],
    ],
    [
      canonicalItems,
      locationSkuColumns.map((key) => ({
        key,
        note: 'Internal location SKU from purchase-history rows matched directly to this canonical item (not via a product).',
      })),
    ],
  ])

  const wb = XLSX.utils.book_new()

  const dictionary: (string | number | boolean)[][] = [
    ['sheet', 'column', 'type', 'nullable', 'rowCount', 'sheetDescription'],
  ]

  for (const { sheet, cols, rows } of results) {
    const derived = derivedColumns.get(sheet.table) ?? []
    const header = [...cols.map(([key]) => key), ...derived.map((d) => d.key)]
    const body = rows.map((r) => header.map((k) => toCell(r[k])))
    const ws = XLSX.utils.aoa_to_sheet([header, ...body])
    ws['!cols'] = header.map((h) => ({ wch: Math.max(10, Math.min(40, h.length + 4)) }))
    XLSX.utils.book_append_sheet(wb, ws, sheet.name)

    for (const [key, col] of cols) {
      dictionary.push([
        sheet.name,
        key,
        col.columnType.replace(/^Pg/, ''),
        !col.notNull,
        rows.length,
        sheet.description,
      ])
    }
    for (const d of derived) {
      dictionary.push([sheet.name, d.key, 'text (derived)', true, rows.length, d.note])
    }
  }

  const crosswalkHeader = [
    'locationId',
    'locationName',
    'locationSku',
    'itemNameAsUploaded',
    'productId',
    'productVendorSku',
    'canonicalItemId',
    'volumeImportId',
    'sourceFile',
  ]
  const productSku = new Map<number, string | null>()
  for (const result of results) {
    if (result.sheet.table !== products) continue
    for (const r of result.rows) productSku.set(r.id as number, (r.vendorSku as string) ?? null)
  }
  const crosswalkBody = locationSkuRows.map((r) => [
    r.locationId,
    locationName.get(r.locationId) ?? null,
    r.sku?.trim() ?? null,
    r.itemName,
    r.productId,
    r.productId != null ? (productSku.get(r.productId) ?? null) : null,
    r.canonicalItemId,
    r.volumeImportId,
    r.fileName,
  ])
  const crosswalkWs = XLSX.utils.aoa_to_sheet([crosswalkHeader, ...crosswalkBody])
  crosswalkWs['!cols'] = crosswalkHeader.map((h) => ({ wch: Math.max(12, h.length + 4) }))
  XLSX.utils.book_append_sheet(wb, crosswalkWs, 'Location SKU Crosswalk')
  const crosswalkNote =
    'One row per internal location SKU from committed, confirmed purchase-history uploads, mapped to the product (and its vendor SKU) or canonical item it was matched to.'
  for (const h of crosswalkHeader) {
    dictionary.push(['Location SKU Crosswalk', h, 'derived', true, crosswalkBody.length, crosswalkNote])
  }

  const dictWs = XLSX.utils.aoa_to_sheet(dictionary)
  dictWs['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 80 }]
  XLSX.utils.book_append_sheet(wb, dictWs, 'Data Dictionary')

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const stamp = new Date().toISOString().slice(0, 10)

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="ace-procurement-item-database-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
