import { generateText, Output } from 'ai'
import * as z from 'zod'

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
    .describe('Selling unit of measure, e.g. "each", "box", "jug", "case"'),
  packSize: z
    .number()
    .nullable()
    .describe(
      'How many base units are contained in ONE selling unit. Examples: "box of 100" => 100; "5 L jug" => 5; "case of 24" => 24; a single "each" => 1. Default 1 if the selling unit IS the base unit.',
    ),
  baseUnit: z
    .string()
    .nullable()
    .describe(
      'The underlying base unit of measure that packSize counts, e.g. "each", "litre", "kg", "metre". For a "box of 100 bolts" this is "each"; for a "5 L jug" this is "litre".',
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
  minOrderQty: z
    .number()
    .nullable()
    .describe('Minimum order quantity, if stated.'),
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
- Interpret freight terms carefully:
  - If a price is described as "delivered", "DDP", "freight included", or "landed", set freightTerms to "delivered" and put that price in unitPrice.
  - If a price is "FOB", "EXW", "ex-works", "pickup", or freight is listed separately, set freightTerms to "fob" and put any freight in shippingCost.
  - If BOTH an FOB price and a delivered price are given for the same item, set freightTerms to "both", put the FOB price in unitPrice and the delivered price in deliveredPrice.
  - If unclear, default to "fob".
- Freight must be expressed PER SINGLE SELLING UNIT, matching unitPrice:
  - If freight is quoted per order, per shipment, per pallet, or per load, divide it by the order/quantity it covers to get a per-unit figure (e.g. "$120 freight per order, min 10" => 12 per unit).
  - If freight is already stated per unit, use it as-is.
  - If a price is delivered/landed, freight is already included — set shippingCost to 0.
- Numbers must be plain numbers without currency symbols or thousands separators.
- Pack size: infer how many base units are inside one selling unit so prices can be normalized.
  - "box/100", "box of 100", "pack of 50" => packSize is that count, baseUnit "each".
  - "5 L jug", "5L", "5 litre container" => packSize 5, baseUnit "litre".
  - "25 kg bag" => packSize 25, baseUnit "kg".
  - "case of 24" => packSize 24, baseUnit "each".
  - If the selling unit is already the base unit (e.g. plain "each", "pair", per "litre"), packSize is 1 and baseUnit equals that unit.
  - When unsure, use packSize 1 and copy the selling unit into baseUnit.
- If a value is not present, return null for it.`

type ExtractInput =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; data: Buffer | Uint8Array; filename: string }

export async function extractPriceRows(
  input: ExtractInput,
): Promise<ExtractionResult> {
  const content:
    | { type: 'text'; text: string }[]
    | (
        | { type: 'text'; text: string }
        | { type: 'file'; data: Buffer | Uint8Array; mediaType: string; filename: string }
      )[] =
    input.kind === 'text'
      ? [
          {
            type: 'text',
            text: `Extract all priced line items from this price list:\n\n${input.text}`,
          },
        ]
      : [
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
        ]

  // Fail fast instead of hanging until the platform's hard function timeout.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)

  try {
    const { output } = await generateText({
      model: 'google/gemini-2.5-flash',
      system: SYSTEM_PROMPT,
      output: Output.object({ schema: extractionSchema }),
      messages: [{ role: 'user', content }],
      maxOutputTokens: 8000,
      maxRetries: 1,
      abortSignal: controller.signal,
    })

    return output
  } finally {
    clearTimeout(timeout)
  }
}
