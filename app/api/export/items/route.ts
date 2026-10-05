import * as XLSX from 'xlsx'
import { getTableColumns, type Column } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '@/lib/db'
import {
  products,
  canonicalItems,
  vendors,
  locations,
  vendorPrices,
  purchaseVolumes,
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

  const wb = XLSX.utils.book_new()

  const dictionary: (string | number | boolean)[][] = [
    ['sheet', 'column', 'type', 'nullable', 'rowCount', 'sheetDescription'],
  ]

  for (const { sheet, cols, rows } of results) {
    const header = cols.map(([key]) => key)
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
