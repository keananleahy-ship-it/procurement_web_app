import { type NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import * as XLSX from 'xlsx'
import { eq } from 'drizzle-orm'
import { getCurrentUser, canEdit } from '@/lib/roles'
import { db } from '@/lib/db'
import {
  volumeImports,
  volumeImportRows,
  canonicalItems,
  products,
  locations,
} from '@/lib/db/schema'
import { extractVolumeRows, type ExtractedVolumeRow } from '@/lib/extract'
import { bestMatch } from '@/lib/match'

// Purchase-history sheets can be large; mirror the price-import budget so big
// files don't get killed mid-extraction.
export const maxDuration = 300

const MAX_TEXT_CHARS = 120_000

// Same compact CSV-ification used by the price import: drop empty rows, trim
// trailing empty cells, and cap total characters so a huge used-range doesn't
// balloon the prompt.
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
      let end = row.length
      while (end > 0 && String(row[end - 1] ?? '').trim() === '') end--
      if (end === 0) continue
      const cells = row.slice(0, end).map((c) => {
        const s = String(c ?? '').trim()
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

function toNumericString(n: number | null, scale: number): string | null {
  if (n === null || Number.isNaN(n)) return null
  return n.toFixed(scale)
}

// Auto-match an item name to a match target. Canonical items are preferred
// because a canonical item spans vendors, so volume attached to it applies to
// every offer for that product; only when no canonical item clears the
// threshold do we fall back to a standalone product.
type MatchTarget = { id: number; name: string; category: string | null }

function resolveMatch(
  row: ExtractedVolumeRow,
  canon: MatchTarget[],
  prods: MatchTarget[],
): {
  canonicalItemId: number | null
  productId: number | null
  matchName: string | null
  matchStatus: 'suggested' | 'unmatched'
  matchScore: number | null
} {
  const product = { name: row.itemName, category: null as string | null }
  const canonHit = bestMatch(product, canon, 0.5)
  if (canonHit) {
    const hit = canon.find((c) => c.id === canonHit.canonicalItemId)
    return {
      canonicalItemId: canonHit.canonicalItemId,
      productId: null,
      matchName: hit?.name ?? null,
      matchStatus: 'suggested',
      matchScore: canonHit.score,
    }
  }
  const prodHit = bestMatch(product, prods, 0.5)
  if (prodHit) {
    const hit = prods.find((p) => p.id === prodHit.canonicalItemId)
    return {
      canonicalItemId: null,
      productId: prodHit.canonicalItemId,
      matchName: hit?.name ?? null,
      matchStatus: 'suggested',
      matchScore: prodHit.score,
    }
  }
  return {
    canonicalItemId: null,
    productId: null,
    matchName: null,
    matchStatus: 'unmatched',
    matchScore: null,
  }
}

export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser()
  if (!currentUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canEdit(currentUser.role)) {
    return NextResponse.json(
      {
        error:
          'Forbidden: uploading purchase volumes requires uploader or admin access.',
      },
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
  const locationRaw = formData.get('locationId')
  const locationId =
    locationRaw && String(locationRaw) !== '' ? Number(locationRaw) : null
  const defaultPeriod =
    String(formData.get('defaultPeriod') ?? '').trim() || null

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }
  // Volume data is meaningless without a location — every purchase belongs to a
  // site — so the location is required and must belong to this user.
  if (!locationId || Number.isNaN(locationId)) {
    return NextResponse.json(
      { error: 'A location is required for a purchase-volume upload.' },
      { status: 400 },
    )
  }
  const [loc] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1)
  if (!loc) {
    return NextResponse.json(
      { error: 'That location was not found.' },
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

  const blob = await put(
    `volumes/${userId}/${Date.now()}-${file.name}`,
    buffer,
    {
      access: 'private',
      contentType:
        file.type || (isPdf ? 'application/pdf' : 'application/octet-stream'),
    },
  )

  let extraction
  try {
    if (isPdf) {
      extraction = await extractVolumeRows({
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
              'The spreadsheet appears to be empty. Make sure the purchase data is on the first sheet.',
          },
          { status: 422 },
        )
      }
      extraction = await extractVolumeRows({ kind: 'text', text })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v0] volume extraction failed:', message)
    const isRateLimited = /rate.?limit|free tier|429|quota/i.test(message)
    const isTimeout = /abort|timed out|timeout/i.test(message)
    return NextResponse.json(
      {
        error: isRateLimited
          ? 'The AI service is rate-limited on the free tier, so large files cannot be processed. Add AI Gateway credits to your Vercel team (and redeploy so the new credentials take effect) to enable full extraction.'
          : isTimeout
            ? 'Reading this file took too long. Try a smaller file or split it into fewer rows.'
            : 'Could not read purchase data from this file. Please check that it contains a table of items and quantities.',
      },
      { status: 422 },
    )
  }

  const rows = (extraction.rows ?? []).filter((r) => r.itemName?.trim())
  const fileType = isPdf ? 'pdf' : 'xls'

  // Load this user's match targets once, then auto-match every row in memory.
  const [canon, prods] = await Promise.all([
    db
      .select({
        id: canonicalItems.id,
        name: canonicalItems.name,
        category: canonicalItems.category,
      })
      .from(canonicalItems)
      .where(eq(canonicalItems.userId, userId)),
    db
      .select({
        id: products.id,
        name: products.name,
        category: products.category,
      })
      .from(products)
      .where(eq(products.userId, userId)),
  ])

  const [created] = await db
    .insert(volumeImports)
    .values({
      userId,
      locationId,
      fileName: file.name,
      blobPathname: blob.pathname,
      fileType,
      defaultPeriod,
      status: 'pending',
      rowCount: rows.length,
    })
    .returning({ id: volumeImports.id })

  const volumeImportId = created.id

  if (rows.length > 0) {
    await db.insert(volumeImportRows).values(
      rows.map((r) => {
        const match = resolveMatch(r, canon, prods)
        return {
          userId,
          volumeImportId,
          itemName: r.itemName.trim(),
          sku: r.sku?.trim() || null,
          annualVolume: toNumericString(r.annualQuantity, 2),
          baseUnit: r.baseUnit?.trim() || null,
          baselineUnitCost: toNumericString(r.avgUnitCost, 4),
          period: r.period?.trim() || null,
          canonicalItemId: match.canonicalItemId,
          productId: match.productId,
          matchName: match.matchName,
          matchStatus: match.matchStatus,
          matchScore:
            match.matchScore !== null ? match.matchScore.toFixed(4) : null,
          include: true,
        }
      }),
    )
  }

  return NextResponse.json({ volumeImportId, rowCount: rows.length })
}
