import { type NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import * as XLSX from 'xlsx'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { imports, importRows } from '@/lib/db/schema'
import { extractPriceRows, type ExtractedRow } from '@/lib/extract'

export const maxDuration = 60

function normalizeFreight(v: ExtractedRow['freightTerms']): string {
  return v === 'delivered' || v === 'both' ? v : 'fob'
}

function toNumericString(n: number | null): string | null {
  if (n === null || Number.isNaN(n)) return null
  return n.toFixed(2)
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  const effectiveDate = String(formData.get('effectiveDate') ?? '').trim()
  const locationRaw = formData.get('locationId')
  const locationId =
    locationRaw && String(locationRaw) !== '' ? Number(locationRaw) : null

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (!effectiveDate) {
    return NextResponse.json(
      { error: 'An effective date is required' },
      { status: 400 },
    )
  }

  const lower = file.name.toLowerCase()
  const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf'
  const isXls =
    lower.endsWith('.xls') ||
    lower.endsWith('.xlsx') ||
    lower.endsWith('.csv') ||
    file.type.includes('spreadsheet') ||
    file.type.includes('excel') ||
    file.type === 'text/csv'

  if (!isPdf && !isXls) {
    return NextResponse.json(
      { error: 'Unsupported file type. Upload a PDF, XLS, XLSX, or CSV file.' },
      { status: 400 },
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // Store the original file privately for audit/history.
  const blob = await put(`imports/${userId}/${Date.now()}-${file.name}`, buffer, {
    access: 'private',
    contentType: file.type || (isPdf ? 'application/pdf' : 'application/octet-stream'),
  })

  // Parse + AI-extract structured rows.
  let extraction
  try {
    if (isPdf) {
      extraction = await extractPriceRows({
        kind: 'pdf',
        data: buffer,
        filename: file.name,
      })
    } else {
      const wb = XLSX.read(buffer, { type: 'buffer' })
      const text = wb.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name])
        return `# Sheet: ${name}\n${csv}`
      }).join('\n\n')
      extraction = await extractPriceRows({ kind: 'text', text })
    }
  } catch (err) {
    console.error('[v0] extraction failed:', err)
    return NextResponse.json(
      {
        error:
          'Could not read pricing from this file. Please check the format.',
      },
      { status: 422 },
    )
  }

  const rows = (extraction.rows ?? []).filter((r) => r.productName?.trim())
  const fileType = isPdf ? 'pdf' : 'xls'

  // Create the import record, then its staging rows.
  const [created] = await db
    .insert(imports)
    .values({
      userId,
      locationId,
      fileName: file.name,
      blobPathname: blob.pathname,
      fileType,
      effectiveDate,
      status: 'pending',
      rowCount: rows.length,
      note: extraction.defaultVendorName
        ? `Document vendor: ${extraction.defaultVendorName}`
        : null,
    })
    .returning({ id: imports.id })

  const importId = created.id

  if (rows.length > 0) {
    await db.insert(importRows).values(
      rows.map((r) => ({
        userId,
        importId,
        productName: r.productName.trim(),
        vendorName: r.vendorName?.trim() || extraction.defaultVendorName || null,
        sku: r.sku?.trim() || null,
        unit: r.unit?.trim() || null,
        category: r.category?.trim() || null,
        unitPrice: toNumericString(r.unitPrice),
        shippingCost: toNumericString(r.shippingCost) ?? '0',
        freightTerms: normalizeFreight(r.freightTerms),
        deliveredPrice: toNumericString(r.deliveredPrice),
        minOrderQty: r.minOrderQty && r.minOrderQty > 0 ? Math.round(r.minOrderQty) : 1,
        currency: (r.currency?.trim() || 'USD').toUpperCase(),
        include: true,
      })),
    )
  }

  return NextResponse.json({ importId, rowCount: rows.length })
}
