import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import * as z from 'zod'

// Call OpenAI directly with the user's own API key, bypassing the Vercel AI
// Gateway entirely. This avoids the gateway's team-scoped billing/free-tier
// limits — usage is billed straight to this OpenAI account.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Note: OpenAI/Gateway strict mode requires every property to be present, so we
// use .nullable() (never .optional()) for fields the model may not find.
const extractedRowSchema = z.object({
  productName: z
    .string()
    .describe('The product or line item name as printed in the document'),
  sku: z.string().nullable().describe('Vendor SKU / part number, if present'),
  unit: z
    .string()
    .nullable()
    .describe(
      'The basis the PRICE is quoted in (the per-what of unitPrice), e.g. "USG", "each", "litre", "case". Not the container.',
    ),
  packSize: z
    .number()
    .nullable()
    .describe(
      'The physical container/package capacity, independent of the pricing unit. Examples: "205L DRUM" => 205; "20L PAIL" => 20; "55USG DRUM" => 55; "box of 100" => 100; "12 x 1L" => 12. Use 1 only when no container size is stated.',
    ),
  baseUnit: z
    .string()
    .nullable()
    .describe(
      'The unit of the container capacity in packSize, e.g. "litre", "USG", "kg", "each". For "205L DRUM" this is "litre"; for "55USG DRUM" this is "USG"; for "box of 100" this is "each".',
    ),
  containerRaw: z
    .string()
    .nullable()
    .describe(
      'The EXACT container/package/size text as printed in the source (e.g. "DR", "4/1 GAL", "205L DRUM", "CS/6"), before any interpretation. Null only if no size/container descriptor appears for the row.',
    ),
  containerAmbiguous: z
    .boolean()
    .describe(
      'True when a container/size descriptor IS present but you are NOT confident how to turn it into packSize + baseUnit (unfamiliar shorthand, missing/implied unit, abbreviation you had to guess). False when no size is stated, or when you parsed the size confidently.',
    ),
  category: z.string().nullable().describe('Product category, if present'),
  vendorName: z
    .string()
    .nullable()
    .describe(
      'The vendor/supplier offering this line. Null if it matches the document-wide vendor.',
    ),
  unitPrice: z
    .number()
    .nullable()
    .describe(
      'The per-unit price. For delivered terms this is the all-in price; for FOB this is the origin price.',
    ),
  shippingCost: z
    .number()
    .nullable()
    .describe(
      'Inbound freight expressed PER SINGLE SELLING UNIT (same basis as unitPrice). If the source quotes freight per order/shipment/load, divide it by the order quantity to get a per-unit figure. If freight is already per unit, use it directly. Use 0 for delivered terms.',
    ),
  freightTerms: z
    .enum(['fob', 'delivered', 'both'])
    .nullable()
    .describe(
      "Freight basis: 'fob' (buyer pays freight), 'delivered' (price includes freight), or 'both' if both an FOB and a delivered price are given.",
    ),
  deliveredPrice: z
    .number()
    .nullable()
    .describe('A separate delivered per-unit price when terms are "both".'),
  currency: z
    .string()
    .nullable()
    .describe('ISO currency code such as USD, EUR. Default USD if unclear.'),
})

const extractionSchema = z.object({
  defaultVendorName: z
    .string()
    .nullable()
    .describe(
      'If the entire document represents one vendor/supplier, their name. Otherwise null.',
    ),
  rows: z
    .array(extractedRowSchema)
    .describe('Every priced line item found in the document.'),
})

export type ExtractedRow = z.infer<typeof extractedRowSchema>
export type ExtractionResult = z.infer<typeof extractionSchema>

const SYSTEM_PROMPT = `You are a procurement data extraction assistant. You are given a vendor price list (a spreadsheet exported to text, or a PDF). Extract every priced line item.

Rules:
- Only extract real product/price rows. Ignore headers, totals, notes, page numbers, and blank rows.
- Product names:
  - Use the full descriptive product name exactly as printed, combining a description column with any adjacent size/grade/spec columns when they belong to the same item (e.g. description "Bolt, hex" + size "M8 x 50" => "Bolt, hex M8 x 50").
  - Do NOT put the SKU/part number in productName; that belongs in sku. Do NOT put pack/size text that you have already parsed into packSize as the entire name — keep the descriptive name.
  - Never leave productName blank. If only a code is present, use that code as the name.
- Vendor names:
  - The vendor/supplier is usually named once in the document title, letterhead, header preamble, or a "Vendor"/"Supplier"/"Quote from" field — NOT in each row. Capture it in defaultVendorName.
  - Only set a row-level vendorName when that specific row is from a DIFFERENT supplier than the document-wide vendor (e.g. a multi-vendor comparison sheet). Otherwise leave vendorName null.
  - Do not invent a vendor from a brand/manufacturer name in a product description — a brand on a product is not the selling vendor.
- Interpret freight terms carefully:
  - If a price is described as "delivered", "DDP", "freight included", or "landed", set freightTerms to "delivered" and put that price in unitPrice.
  - If a price is "FOB", "EXW", "ex-works", "pickup", or freight is listed separately, set freightTerms to "fob" and put any freight in shippingCost.
  - If BOTH an FOB price and a delivered price are given for the same item, set freightTerms to "both", put the FOB price in unitPrice and the delivered price in deliveredPrice.
  - CONSISTENCY: when the price list pairs an FOB price with a separate per-unit freight/delivery surcharge (e.g. a "+$0.45/gal delivered" column or a freight column that applies to every row), treat EVERY such row the same way: set freightTerms "both", put the FOB price in unitPrice, the surcharge in shippingCost, and the delivered price in deliveredPrice. If the delivered price isn't printed explicitly, compute it as unitPrice + shippingCost. Do NOT classify some rows as "fob" and visually-identical rows as "both" — apply one rule to the whole file.
  - If unclear, default to "fob".
- Freight must be expressed PER SINGLE SELLING UNIT, matching unitPrice:
  - If freight is quoted per order, per shipment, per pallet, or per load, divide it by the order/quantity it covers to get a per-unit figure (e.g. "$120 freight per order, min 10" => 12 per unit).
  - If freight is already stated per unit, use it as-is.
  - If a price is delivered/landed, freight is already included — set shippingCost to 0.
- Numbers must be plain numbers without currency symbols or thousands separators.
- unit vs packSize/baseUnit — these are TWO SEPARATE things, do not conflate them:
  - "unit" is the basis the PRICE is quoted in (the per-what of unitPrice). e.g. if the sheet quotes a price "per US gallon", unit is "USG"; if "per each", unit is "each"; if "per case", unit is "case". Keep unitPrice on that basis — do NOT recompute the price.
  - "packSize" + "baseUnit" describe the PHYSICAL container/package the item ships in, regardless of how the price is quoted. Always capture the container capacity when the description names one.
- Container/package parsing (set packSize = capacity number, baseUnit = its unit):
  - "205L DRUM" => packSize 205, baseUnit "litre". "20L PAIL" => packSize 20, baseUnit "litre". "1040L IBC"/"1040L TOTE" => packSize 1040, baseUnit "litre".
  - "55USG DRUM" => packSize 55, baseUnit "USG". "5 GAL PAIL" => packSize 5, baseUnit "USG".
  - "25 kg bag", "25kg" => packSize 25, baseUnit "kg". "400g", "400 g" => packSize 400, baseUnit "g".
  - Small units are supported and will be converted automatically: volume "ml"/"cc", "fl oz", "pt"/"pint", "qt"/"quart" fold into gallons; weight "oz"/"ounce", "g"/"gram" fold into pounds. Use them as baseUnit when the container is stated that way (e.g. "500ml bottle" => packSize 500, baseUnit "ml"; "16oz tub" => packSize 16, baseUnit "oz").
  - "oz" DEFAULTS to weight ounces (→ pounds). Only use "fl oz" as baseUnit when the source explicitly says fluid ounces or the product is clearly a liquid measured by fluid volume.
  - "box of 100", "100/box", "ctn 100", "pack of 50" => packSize 100/50, baseUnit "each".
  - "case of 24", "24 pk", "24-pack" => packSize 24, baseUnit "each".
  - Multipliers give TOTAL base content (multiply the count by the per-unit size): "12 x 1L" => packSize 12, baseUnit "litre"; "4 x 5kg" => packSize 20, baseUnit "kg"; "30 x 400g" / "30x400g" => packSize 12000, baseUnit "g"; "24 x 500ml" => packSize 12, baseUnit "litre".
  - Slash "count/size" pack notation (e.g. "12/1", "4/1 GAL", "40/14 LB") is INCONSISTENT on these sheets and must be treated carefully. The first number is the count of containers. The meaning of the second number and any trailing unit varies, so ALWAYS set containerAmbiguous true for slash notation, give your best-guess packSize/baseUnit, and let a human verify. Use these interpretations for the best guess:
    - Trailing unit reads as the PER-CONTAINER size (volume like GAL/L): multiply through. "4/1 GAL" => 4 × 1 gal => packSize 4, baseUnit "USG"; "6/5 L" => packSize 30, baseUnit "litre".
    - Trailing unit reads as the case TOTAL / pricing basis (a weight like LB/KG with many small items): the trailing unit is the whole-case amount, NOT the per-item size. "40/14 LB" is a case of 40 × 14 oz tubes totalling 35 lb => packSize 35, baseUnit "lb" (do not output 40 × 14 lb). When the per-item unit (e.g. oz) is implied, you may instead express the total in that unit if clearer.
    - Bare number, no unit: assume QUARTS per these sheets. "12/1" => 12 × 1 quart => packSize 12, baseUnit "quart" (a 12 × 1-quart case, i.e. 3 gallons); "6/4" => packSize 24, baseUnit "quart".
  - Even when the price is quoted per gallon/litre/each, STILL fill packSize/baseUnit from the container named in the description (e.g. a row priced per USG for a "205L DRUM" => unit "USG", packSize 205, baseUnit "litre").
- Do NOT duplicate the size in productName: if you put the container size into packSize/baseUnit, include it at most once in the name. Never repeat it (e.g. output "ACCUFLO TK 68 1040L IBC", never "ACCUFLO TK 68 1040L IBC 1040L IBC").
- Dimensions/specs that are NOT pack quantities (e.g. "M8 x 50mm" bolt size, "2400 x 1200" sheet size) belong in the product name, NOT packSize.
  - If no container/package size is stated, packSize is 1 and baseUnit equals the selling unit. Never guess a large pack count.
- Container confidence (IMPORTANT for accuracy):
  - Always copy the exact size/container text you see into containerRaw (e.g. "DR", "4/1 GAL", "205L DRUM", "CS/6"). This is the literal source text, not your interpretation.
  - Set containerAmbiguous to true whenever a size/container descriptor is present but you are NOT confident how to convert it to packSize + baseUnit — unfamiliar shorthand, an abbreviation you had to guess, or a missing/implied unit. Still provide your best-guess packSize/baseUnit, but flag it.
  - Set containerAmbiguous to false when no size is stated at all, or when you parsed the container with high confidence from a clearly written description.
  - When in doubt, prefer flagging (true) over a silent guess — a human will verify flagged rows.
  - If a value is not present, return null for it.`

type ExtractInput =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; data: Buffer | Uint8Array; filename: string }

type UserContent =
  | { type: 'text'; text: string }
  | {
      type: 'file'
      data: Buffer | Uint8Array
      mediaType: string
      filename: string
    }

// One structured-output call. Kept small per call so output never truncates.
async function runExtraction(
  content: UserContent[],
  maxOutputTokens: number,
): Promise<ExtractionResult> {
  // Fail fast instead of hanging until the platform's hard function timeout,
  // but allow enough headroom for the SDK's retry/backoff on rate limits.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)

  try {
    const { output } = await generateText({
      // gpt-4.1-mini is a non-reasoning model with reliable strict structured
      // output. Gemini 2.5's reasoning tokens count against maxOutputTokens and
      // could consume the whole budget for large tables, yielding "No output
      // generated"; this model has no such failure mode and is fast/cheap.
      model: openai('gpt-4.1-mini'),
      system: SYSTEM_PROMPT,
      output: Output.object({ schema: extractionSchema }),
      messages: [{ role: 'user', content }],
      maxOutputTokens,
      // Rate-limit errors are retryable; the SDK backs off exponentially.
      maxRetries: 4,
      abortSignal: controller.signal,
    })
    return output
  } finally {
    clearTimeout(timeout)
  }
}

// Run async tasks with a bounded concurrency so we don't open hundreds of
// gateway connections at once for very large files.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

// A single model call reliably handles a few dozen rows; beyond that the JSON
// output truncates. So we split spreadsheet rows into batches, extract each in
// parallel, and merge the results.
const ROWS_PER_CHUNK = 40
const CONCURRENCY = 8
const CHUNK_MAX_TOKENS = 24_000

async function extractTextChunked(text: string): Promise<ExtractionResult> {
  const allLines = text.split('\n')

  // The first non-blank, non-"# Sheet:" line is the column header; prepend it
  // to every chunk so each batch keeps its column context.
  const headerIdx = allLines.findIndex(
    (l) => l.trim() !== '' && !l.trim().startsWith('#'),
  )
  const header = headerIdx >= 0 ? allLines[headerIdx] : ''

  // Lines BEFORE the column header are usually the title/letterhead/preamble
  // where the document-wide vendor name lives. Keep a trimmed copy so every
  // chunk — not just the first — retains vendor context. Without this, later
  // chunks lose the vendor entirely and misattribute it.
  const preamble = allLines
    .slice(0, headerIdx >= 0 ? headerIdx : 0)
    .filter((l) => l.trim() !== '')
    .slice(0, 15)
    .join('\n')

  const dataLines = allLines
    .slice(headerIdx + 1)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))

  // Small files: a single call is fine and avoids extra round-trips.
  if (dataLines.length <= ROWS_PER_CHUNK) {
    return runExtraction(
      [
        {
          type: 'text',
          text: `Extract all priced line items from this price list:\n\n${text}`,
        },
      ],
      CHUNK_MAX_TOKENS,
    )
  }

  const chunks: string[] = []
  for (let i = 0; i < dataLines.length; i += ROWS_PER_CHUNK) {
    const batch = dataLines.slice(i, i + ROWS_PER_CHUNK)
    chunks.push([header, ...batch].join('\n'))
  }

  const vendorContext = preamble
    ? `Document header / vendor context (applies to every row in this section):\n${preamble}\n\n`
    : ''

  const settled = await mapWithConcurrency(chunks, CONCURRENCY, (chunk) =>
    runExtraction(
      [
        {
          type: 'text',
          text: `Extract all priced line items from this section of a vendor price list. Use the document header/vendor context to set defaultVendorName. The first line after the context is the column header.\n\n${vendorContext}${chunk}`,
        },
      ],
      CHUNK_MAX_TOKENS,
    ),
  )

  const merged: ExtractionResult = { defaultVendorName: null, rows: [] }
  let anySuccess = false
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.error('[v0] chunk extraction failed:', result.reason)
      continue
    }
    anySuccess = true
    if (!merged.defaultVendorName && result.value.defaultVendorName) {
      merged.defaultVendorName = result.value.defaultVendorName
    }
    merged.rows.push(...result.value.rows)
  }

  if (!anySuccess) {
    throw new Error('No output generated.')
  }

  return merged
}

export async function extractPriceRows(
  input: ExtractInput,
): Promise<ExtractionResult> {
  if (input.kind === 'text') {
    return extractTextChunked(input.text)
  }

  // PDFs can't be cheaply split, so send the whole document with a large
  // output budget.
  return runExtraction(
    [
      {
        type: 'text',
        text: 'Extract all priced line items from this attached price list document.',
      },
      {
        type: 'file',
        data: input.data,
        mediaType: 'application/pdf',
        filename: input.filename,
      },
    ],
    32_000,
  )
}
