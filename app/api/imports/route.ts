import { type NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import * as XLSX from 'xlsx'
import { getCurrentUser, canEdit, canAdmin } from '@/lib/roles'
import { db } from '@/lib/db'
import { imports, importRows, vendors, locations } from '@/lib/db/schema'
import { asc } from 'drizzle-orm'
import { extractPriceRows, type ExtractedRow } from '@/lib/extract'

export const maxDuration = 120

// Cap how much text we send to the model. XLSX sheets can have a huge "used
// range" full of empty cells; without bounding this the prompt balloons to
// megabytes of commas and the model stalls or returns no output.
const MAX_TEXT_CHARS = 120_000

// Convert a workbook to compact CSV-like text: skip fully-empty rows, trim
// trailing empty cells per row, and stop once we hit the character cap.
function workbookToText(wb: XLSX.WorkBook): string {
  const parts: string[] = []
  let total = 0

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    })

    const lines: string[] = []
    for (const row of rows) {
      // Trim trailing empty cells so wide formatted ranges don't bloat output.
      let end = row.length
      while (end > 0 && String(row[end - 1] ?? '').trim() === '') end--
      if (end === 0) continue // fully empty row

      const cells = row.slice(0, end).map((c) => {
        const s = String(c ?? '').trim()
        // Quote cells containing commas/quotes so columns stay aligned.
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      })
      lines.push(cells.join(','))
    }

    if (lines.length === 0) continue
    const block = `# Sheet: ${name}\n${lines.join('\n')}`
    parts.push(block)
    total += block.length
    if (total > MAX_TEXT_CHARS) break
  }

  const text = parts.join('\n\n')
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
}

function normalizeFreight(v: ExtractedRow['freightTerms']): string {
  return v === 'delivered' || v === 'both' ? v : 'fob'
}

function toNumericString(n: number | null): string | null {
  if (n === null || Number.isNaN(n)) return null
  return n.toFixed(2)
}

// Most vendors quote in US gallons, so we normalize litre-based container
// capacities to gallons at import time for apples-to-apples comparison.
const LITRES_PER_USG = 3.785411784
const LITRE_ALIASES = new Set([
  'l',
  'litre',
  'litres',
  'liter',
  'liters',
  'ltr',
  'ltrs',
])
const GALLON_ALIASES = new Set([
  'usg',
  'gal',
  'gals',
  'gallon',
  'gallons',
  'us gal',
  'us gallon',
])
const QUARTS_PER_USG = 4
const QUART_ALIASES = new Set([
  'qt',
  'qts',
  'quart',
  'quarts',
])
const ML_PER_USG = 3785.411784
const ML_ALIASES = new Set([
  'ml',
  'mls',
  'millilitre',
  'millilitres',
  'milliliter',
  'milliliters',
  'cc',
])
const FLOZ_PER_USG = 128
const FLOZ_ALIASES = new Set([
  'fl oz',
  'floz',
  'fl. oz.',
  'fl oz.',
  'fluid ounce',
  'fluid ounces',
])
const PINTS_PER_USG = 8
const PINT_ALIASES = new Set([
  'pt',
  'pts',
  'pint',
  'pints',
])

// Similarly, weight-based container capacities are normalized to pounds so
// kilogram-quoted vendors compare directly against pound-quoted ones.
const KG_PER_LB = 0.45359237
const GRAMS_PER_LB = 453.59237
const KG_PER_TONNE = 1000
const KILOGRAM_ALIASES = new Set([
  'kg',
  'kgs',
  'kilo',
  'kilos',
  'kilogram',
  'kilograms',
])
const GRAM_ALIASES = new Set([
  'g',
  'gr',
  'gm',
  'gms',
  'gram',
  'grams',
  'gramme',
  'grammes',
])
const TONNE_ALIASES = new Set([
  't',
  'mt',
  'tonne',
  'tonnes',
  'metric ton',
  'metric tons',
  'metric tonne',
  'metric tonnes',
])
const POUND_ALIASES = new Set([
  'lb',
  'lbs',
  'pound',
  'pounds',
])
const OUNCES_PER_LB = 16
const OUNCE_ALIASES = new Set([
  'oz',
  'ozs',
  'ounce',
  'ounces',
])

// Given a raw container capacity + base unit, return the capacity expressed in
// a canonical unit: litres → US gallons, kilograms → pounds. Other units
// (each, case, …) pass through unchanged.
function normalizeContainer(
  packSize: number,
  baseUnit: string | null,
): { packSize: string; baseUnit: string | null } {
  const u = baseUnit?.trim().toLowerCase() ?? ''
  if (LITRE_ALIASES.has(u)) {
    return { packSize: (packSize / LITRES_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (GALLON_ALIASES.has(u)) {
    return { packSize: packSize.toFixed(4), baseUnit: 'USG' }
  }
  if (QUART_ALIASES.has(u)) {
    return { packSize: (packSize / QUARTS_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (PINT_ALIASES.has(u)) {
    return { packSize: (packSize / PINTS_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (FLOZ_ALIASES.has(u)) {
    return { packSize: (packSize / FLOZ_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (ML_ALIASES.has(u)) {
    return { packSize: (packSize / ML_PER_USG).toFixed(4), baseUnit: 'USG' }
  }
  if (KILOGRAM_ALIASES.has(u)) {
    return { packSize: (packSize / KG_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  if (GRAM_ALIASES.has(u)) {
    return { packSize: (packSize / GRAMS_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  if (TONNE_ALIASES.has(u)) {
    return { packSize: ((packSize * KG_PER_TONNE) / KG_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  if (POUND_ALIASES.has(u)) {
    return { packSize: packSize.toFixed(4), baseUnit: 'lb' }
  }
  if (OUNCE_ALIASES.has(u)) {
    return { packSize: (packSize / OUNCES_PER_LB).toFixed(4), baseUnit: 'lb' }
  }
  return { packSize: packSize.toFixed(4), baseUnit: baseUnit?.trim() || null }
}

export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser()
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canEdit(currentUser.role)) {
    return NextResponse.json(
      { error: 'Forbidden: uploading imports requires uploader or admin access.' },
      { status: 403 },
    )
  }
  const userId = currentUser.id

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  const effectiveDate = String(formData.get('effectiveDate') ?? '').trim()
  const vendorName = String(formData.get('vendorName') ?? '').trim()
  const locationName = String(formData.get('locationName') ?? '').trim()

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  if (!effectiveDate) {
    return NextResponse.json(
      { error: 'An effective date is required' },
      { status: 400 },
    )
  }
  if (!vendorName) {
    return NextResponse.json(
      { error: 'A vendor is required' },
      { status: 400 },
    )
  }
  if (!locationName) {
    return NextResponse.json(
      { error: 'A location is required' },
      { status: 400 },
    )
  }

  // Enforce the naming convention server-side. Match the submitted name against
  // existing vendors case-insensitively and snap to the stored spelling so we
  // never create near-duplicates (e.g. "Acme" vs "acme"). Non-admins may only
  // pick an existing vendor; admins may introduce a new name.
  const existingVendors = await db
    .select({ name: vendors.name })
    .from(vendors)
    .orderBy(asc(vendors.name))
  const match = existingVendors.find(
    (v) => v.name.toLowerCase() === vendorName.toLowerCase(),
  )
  const resolvedVendorName = match?.name ?? vendorName
  if (!match && !canAdmin(currentUser.role)) {
    return NextResponse.json(
      {
        error:
          'Select an existing vendor. Only an admin can add a new vendor name.',
      },
      { status: 403 },
    )
  }

  // Resolve the location the same way: snap to an existing location
  // case-insensitively, otherwise create it (admins only) so we never end up
  // with near-duplicate location names.
  const existingLocations = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .orderBy(asc(locations.name))
  const locationMatch = existingLocations.find(
    (l) => l.name.toLowerCase() === locationName.toLowerCase(),
  )
  let locationId: number
  if (locationMatch) {
    locationId = locationMatch.id
  } else if (canAdmin(currentUser.role)) {
    const [createdLocation] = await db
      .insert(locations)
      .values({ userId, name: locationName })
      .returning({ id: locations.id })
    locationId = createdLocation.id
  } else {
    return NextResponse.json(
      {
        error:
          'Select an existing location. Only an admin can add a new location name.',
      },
      { status: 403 },
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
      const text = workbookToText(wb)
      if (!text.trim()) {
        return NextResponse.json(
          {
            error:
              'The spreadsheet appears to be empty. Make sure the price data is on the first sheet.',
          },
          { status: 422 },
        )
      }
      extraction = await extractPriceRows({ kind: 'text', text })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v0] extraction failed:', message)
    const isRateLimited = /rate.?limit|free tier|429|quota/i.test(message)
    const isTimeout = /abort|timed out|timeout/i.test(message)
    return NextResponse.json(
      {
        error: isRateLimited
          ? 'The AI service is rate-limited on the free tier, so large files cannot be processed. Add AI Gateway credits to your Vercel team (and redeploy so the new credentials take effect) to enable full extraction.'
          : isTimeout
            ? 'Reading this file took too long. Try a smaller file or split it into fewer rows.'
            : 'Could not read pricing from this file. Please check that it contains a table of products and prices.',
      },
      { status: 422 },
    )
  }

  const rows = (extraction.rows ?? []).filter((r) => r.productName?.trim())
  const fileType = isPdf ? 'pdf' : 'xls'

  // Determine the file's dominant pricing unit so we can flag outlier rows
  // (e.g. a single "case"-priced line in a file otherwise quoted per "USG")
  // for manual review rather than silently mixing pricing bases.
  const unitCounts = new Map<string, number>()
  for (const r of rows) {
    const u = r.unit?.trim().toLowerCase()
    if (u) unitCounts.set(u, (unitCounts.get(u) ?? 0) + 1)
  }
  let dominantUnit: string | null = null
  let dominantCount = 0
  for (const [u, c] of unitCounts) {
    if (c > dominantCount) {
      dominantUnit = u
      dominantCount = c
    }
  }
  // Only treat a unit as "dominant" when there's a real majority to compare
  // against; a file with no consistent unit shouldn't flag everything.
  const hasDominant = dominantUnit !== null && dominantCount >= 2

  function reviewFor(r: (typeof rows)[number]): string | null {
    const reasons: string[] = []
    const u = r.unit?.trim().toLowerCase() || null
    if (hasDominant && u && u !== dominantUnit) {
      reasons.push(
        `Unit "${r.unit?.trim()}" differs from the file's usual "${dominantUnit}" — verify the price basis and pack size.`,
      )
    }
    if (r.containerAmbiguous) {
      const raw = r.containerRaw?.trim()
      reasons.push(
        `Container size${raw ? ` "${raw}"` : ''} could not be confidently parsed — verify the pack size and unit.`,
      )
    }
    return reasons.length > 0 ? reasons.join(' ') : null
  }

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
      note: `Vendor: ${resolvedVendorName}`,
    })
    .returning({ id: imports.id })

  const importId = created.id

  if (rows.length > 0) {
    await db.insert(importRows).values(
      rows.map((r) => {
        const reviewReason = reviewFor(r)
        const rawPackSize = r.packSize && r.packSize > 0 ? r.packSize : 1
          const { packSize, baseUnit } = normalizeContainer(
          rawPackSize,
          r.baseUnit?.trim() || r.unit?.trim() || null,
        )
        return {
          userId,
          importId,
          productName: r.productName.trim(),
          vendorName: resolvedVendorName,
          sku: r.sku?.trim() || null,
          unit: r.unit?.trim() || null,
          packSize,
          baseUnit,
          category: r.category?.trim() || null,
          unitPrice: toNumericString(r.unitPrice),
          shippingCost: toNumericString(r.shippingCost) ?? '0',
          freightTerms: normalizeFreight(r.freightTerms),
          deliveredPrice: toNumericString(r.deliveredPrice),
          currency: (r.currency?.trim() || 'USD').toUpperCase(),
          needsReview: reviewReason !== null,
          reviewReason,
          include: true,
        }
      }),
    )
  }

  return NextResponse.json({ importId, rowCount: rows.length })
}
