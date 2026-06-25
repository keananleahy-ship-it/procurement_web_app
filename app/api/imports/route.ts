import { type NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import * as XLSX from 'xlsx'
import { getCurrentUser, canEdit, canAdmin } from '@/lib/roles'
import { db } from '@/lib/db'
import {
  imports,
  importRows,
  vendors,
  locations,
  vendorTokenMappings,
} from '@/lib/db/schema'
import { asc, eq, and } from 'drizzle-orm'
import { extractPriceRows, type ExtractedRow } from '@/lib/extract'
import {
  normalizeContainer,
  inferContainer,
  detectUnitSystem,
  resolveCasePack,
  resolveNumberedTote,
} from '@/lib/container-infer'
import {
  detectPriceBasis,
  toPerUnit,
  baseKind,
  baseUnitWord,
  PER_UNIT_CEILING,
} from '@/lib/price-basis'
import {
  buildVendorProfile,
  describeProfileForPrompt,
  type VendorTokenRow,
} from '@/lib/vendor-profile'
import { deriveUnitClass } from '@/lib/unit-class'

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
  const freightDefaultRaw = String(formData.get('freightDefault') ?? 'auto')
  const freightDefault = (['fob', 'delivered', 'both'] as const).includes(
    freightDefaultRaw as 'fob' | 'delivered' | 'both',
  )
    ? (freightDefaultRaw as 'fob' | 'delivered' | 'both')
    : null

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

  // Load THIS vendor's learned nomenclature so the parser and AI extractor use
  // its conventions instead of assuming uniformity across vendors. A brand-new
  // vendor simply has no rows yet (profile = seed defaults).
  const [vendorRow] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.userId, userId), eq(vendors.name, resolvedVendorName)))
    .limit(1)
  const vendorId = vendorRow?.id ?? null
  const tokenRows: VendorTokenRow[] = vendorId
    ? (
        await db
          .select({
            token: vendorTokenMappings.token,
            kind: vendorTokenMappings.kind,
            value: vendorTokenMappings.value,
            source: vendorTokenMappings.source,
          })
          .from(vendorTokenMappings)
          .where(
            and(
              eq(vendorTokenMappings.userId, userId),
              eq(vendorTokenMappings.vendorId, vendorId),
            ),
          )
      ).map((r) => ({
        token: r.token,
        kind: r.kind as VendorTokenRow['kind'],
        value: r.value,
        source: r.source as VendorTokenRow['source'],
      }))
    : []
  const vendorProfile = buildVendorProfile(tokenRows)
  const vendorHint = describeProfileForPrompt(tokenRows)

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
      extraction = await extractPriceRows(
        {
          kind: 'pdf',
          data: buffer,
          filename: file.name,
        },
        { freightHint: freightDefault, vendorHint },
      )
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
      extraction = await extractPriceRows(
        { kind: 'text', text },
        { freightHint: freightDefault, vendorHint },
      )
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

  // Determine this vendor's container-sizing convention (metric vs imperial) so
  // a bare container keyword ("DRUM", "IBC") resolves to the right standard size
  // (205 L vs 55 USG). This reads the explicit size tokens printed in product
  // names — independent of how price is quoted, since some vendors price per
  // US gallon yet describe containers in litres.
  const unitSystem = detectUnitSystem(
    rows.flatMap((r) => [r.productName, r.containerRaw ?? null]),
    rows.flatMap((r) => [r.baseUnit ?? null, r.unit ?? null]),
  )

  // Sold-loose ("BULK") and decanted ("DRUM DECANT", "IBC DECANT") lines are
  // priced per single unit, so their pack size must be 1 even if the extractor
  // read a container size off the surrounding text.
  const BULK_DECANT_RE = /\b(bulk|decant|dcnt)\b/i

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
    // First pass: resolve each row's container size (in gallons/lb), reusing the
    // bulk/decant rule and the standard-size inference for missing containers.
    const sized = rows.map((r) => {
      const containerText = `${r.productName} ${r.sku ?? ''} ${r.containerRaw ?? ''}`
      const isBulkDecant = BULK_DECANT_RE.test(containerText)
      // Bulk/decant lines are a per-unit basis; ignore any extracted container
      // size and treat as 1. Everything else keeps its extracted size.
      const rawPackSize = isBulkDecant
        ? 1
        : r.packSize && r.packSize > 0
          ? r.packSize
          : 1
      // When the extractor found no container size, fall back to a deterministic
      // resolver for known industry shorthands (e.g. "6 USG PETROPAK", a bare
      // "IBC" or "DRUM"). Inferred-by-default sizes are flagged for review.
      let nativeSize = rawPackSize
      let nativeUnit = r.baseUnit?.trim() || r.unit?.trim() || null
      let inferredNote: string | null = null
      // A numbered tote/IBC ("275 Tote") is rated in US gallons in North
      // America; extractors often misread the number as litres. Trust the
      // gallon reading and override any extracted unit.
      const tote = isBulkDecant ? null : resolveNumberedTote(containerText)
      // Multi-unit case packs ("12/1 QT") carry their true volume in the
      // notation. The extractor often stores the outer count (12) with a
      // non-volumetric unit ("each"), so prefer the parsed pack volume — 12
      // quarts here, which normalizes to 3 gal — for an accurate per-gallon basis.
      const casePack = isBulkDecant
        ? null
        : resolveCasePack(containerText, vendorProfile)
      if (tote) {
        nativeSize = tote.gallons
        nativeUnit = 'USG'
      } else if (casePack) {
        nativeSize = casePack.qty
        nativeUnit = casePack.unit
      } else if (!isBulkDecant && rawPackSize === 1) {
        const inf = inferContainer(containerText, unitSystem, vendorProfile)
        if (inf) {
          nativeSize = inf.packSize
          nativeUnit = inf.baseUnit
          if (inf.inferred) {
            inferredNote =
              'Container size inferred from a standard size — verify the pack size.'
          }
        }
      }
      const { packSize, baseUnit } = normalizeContainer(nativeSize, nativeUnit)
      // Classify the item's comparison dimension (volume/weight/each). Per-piece
      // items (filters, parts) end up 'each' and are excluded from the gallon/
      // pound comparison engine downstream.
      const unitClass = deriveUnitClass(baseUnit, {
        profile: vendorProfile,
        text: containerText,
      })
      return { r, isBulkDecant, packSize, baseUnit, unitClass, inferredNote }
    })

    // Detect whether this import quotes per single unit (per gallon/lb) or per
    // whole package (per drum/case/pail). Per-package quotes are converted to a
    // per-unit basis below so they compare against per-gallon vendors.
    const priceBasis = detectPriceBasis(
      sized.map((s) => ({
        packSize: Number(s.packSize),
        baseUnit: s.baseUnit,
        unitPrice: s.r.unitPrice ?? null,
      })),
    )

    await db.insert(importRows).values(
      sized.map(
        ({ r, isBulkDecant, packSize, baseUnit, unitClass, inferredNote }) => {
        let reviewReason = reviewFor(r)
        if (inferredNote) {
          reviewReason = reviewReason
            ? `${reviewReason} ${inferredNote}`
            : inferredNote
        }

        // A user-declared file-level basis overrides per-row detection. For
        // delivered, freight is baked into the unit price, so zero out any
        // separately-extracted shipping to avoid double-counting.
        const freightTerms = freightDefault ?? normalizeFreight(r.freightTerms)
        let unitPrice = r.unitPrice ?? null
        let deliveredPrice = r.deliveredPrice ?? null
        let shipping =
          freightDefault === 'delivered' ? 0 : (r.shippingCost ?? 0)
        let displayUnit = r.unit?.trim() || null

        // Per-package import: divide every monetary field by the container size
        // to express it per base unit, matching the per-gallon comparison basis.
        if (priceBasis === 'per-package') {
          // Every price in this file ends up on a per-gallon / per-pound basis,
          // so report the unit of measure that way rather than echoing the raw
          // packaging token ("Qt", "tote-275", "each"). The original packaging
          // text is preserved in containerRaw.
          displayUnit = baseUnitWord(baseUnit)
          const packGallons = Number(packSize)
          const word = baseUnitWord(baseUnit)
          const ceiling = PER_UNIT_CEILING[baseKind(baseUnit)]
          // Only divide by a size expressed in a real volume/weight unit. A bare
          // count ("12 each" from an unparsed "12/1 Case") is NOT a gallon
          // figure, so dividing by it would invent a wrong per-gallon price.
          const sizeIsMeasured = baseKind(baseUnit) !== 'other'
          if (!isBulkDecant && (packGallons <= 1 || !sizeIsMeasured)) {
            // The price is a package total but we couldn't size the package in a
            // real unit (e.g. an un-parseable "EPACK"/"12/1 Case"), so leave the
            // price as-is and flag it for a manual pack size.
            const note = `This file is priced per package but the container size couldn't be determined — the price shown may be a package total. Verify the pack size.`
            reviewReason = reviewReason ? `${reviewReason} ${note}` : note
          } else if (packGallons > 1) {
            const orig = unitPrice
            unitPrice = toPerUnit(unitPrice, packGallons)
            deliveredPrice = toPerUnit(deliveredPrice, packGallons)
            shipping = toPerUnit(shipping, packGallons) ?? 0
            if (orig != null && unitPrice != null) {
              const note = `Converted to per-${word}: $${orig.toFixed(2)} ÷ ${packGallons.toFixed(2)} ${word} = $${unitPrice.toFixed(2)}/${word}.`
              reviewReason = reviewReason ? `${reviewReason} ${note}` : note
            }
            // A still-high per-unit price usually means the container size is
            // wrong (e.g. a tote mis-read as litres) — flag it to be checked.
            if (unitPrice != null && unitPrice > ceiling) {
              const note = `The converted per-${word} price looks high — verify the container size is correct.`
              reviewReason = reviewReason ? `${reviewReason} ${note}` : note
            }
          }
        }

        return {
          userId,
          importId,
          productName: r.productName.trim(),
          vendorName: resolvedVendorName,
          sku: r.sku?.trim() || null,
          unit: displayUnit,
          packSize,
          baseUnit,
          unitClass,
          containerRaw: r.containerRaw?.trim() || null,
          category: r.category?.trim() || null,
          unitPrice: toNumericString(unitPrice),
          shippingCost: toNumericString(shipping) ?? '0',
          freightTerms,
          deliveredPrice: toNumericString(deliveredPrice),
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
