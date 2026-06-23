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
    .describe('Unit of measure, e.g. "each", "box", "kg"'),
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
    .describe('Separate freight/shipping cost per order, if quoted (FOB).'),
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
- Numbers must be plain numbers without currency symbols or thousands separators.
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

  const { output } = await generateText({
    model: 'google/gemini-3.5-flash',
    system: SYSTEM_PROMPT,
    output: Output.object({ schema: extractionSchema }),
    messages: [{ role: 'user', content }],
  })

  return output
}
