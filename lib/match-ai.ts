import { generateText, Output } from 'ai'
import * as z from 'zod'

// AI-assisted second-pass matching. The fuzzy first pass keys off name
// similarity only, which misses semantic synonyms ("Protective" vs "Safety"
// gloves) and items that differ only by pack size. This pass reasons over the
// full product/canonical lists and proposes matches with a confidence score
// and a short justification. Nothing is auto-confirmed — every proposal is
// staged as a suggestion for human review.

const matchSchema = z.object({
  matches: z.array(
    z.object({
      productId: z
        .number()
        .describe('The id of the vendor product being matched.'),
      canonicalItemId: z
        .number()
        .nullable()
        .describe(
          'The id of the best-fitting canonical item, or null if none is a credible match.',
        ),
      confidence: z
        .number()
        .describe(
          'Confidence from 0 to 1 that this product is the SAME underlying item as the chosen canonical item.',
        ),
      reason: z
        .string()
        .describe(
          'A short (max ~120 char) human-readable justification for the match or non-match.',
        ),
    }),
  ),
})

export type AiMatch = z.infer<typeof matchSchema>['matches'][number]

type ProductInput = {
  id: number
  name: string
  category: string | null
  unit: string | null
  baseUnit: string | null
}

type CanonicalInput = {
  id: number
  name: string
  category: string | null
  baseUnit: string | null
}

const SYSTEM_PROMPT = `You are a procurement catalog reconciliation assistant. You are given a list of vendor PRODUCTS (with ids) and a list of CANONICAL ITEMS (with ids). Match each product to the canonical item that represents the SAME underlying physical item, even when:
- Names use synonyms or different word order ("Protective Gloves" vs "Safety Gloves", "Steel Bolt M8" vs "M8 Steel Bolts").
- The product differs only by PACK SIZE or packaging while the contents are identical (a "box of 100 M8 bolts" and a single "M8 bolt" are the same canonical item; a "5 L jug of lubricant" and "lubricant per litre" are the same canonical item). Pack size must NOT prevent a match — items with identical contents in different pack sizes are the same canonical item.
- Grades/finishes that are functionally equivalent for procurement (e.g. "zinc plated" vs "galvanized") may match; genuinely different specs (different size, material, or grade that changes the part) should NOT match.

Rules:
- Only choose a canonicalItemId from the provided list. If no canonical item is a credible match, return canonicalItemId null with a low confidence and explain why.
- confidence reflects how sure you are it is the same item: 0.9+ near-certain, 0.7-0.9 likely, 0.5-0.7 plausible, <0.5 doubtful.
- Return exactly one entry per product id provided. Keep each reason concise.`

// The model must return one structured entry per product. Asking for hundreds
// at once overflows the output budget and yields no parseable object
// ("AI_NoOutputGeneratedError"), so we match in small batches. Each batch sees
// the full canonical list (which is comparatively small).
const BATCH_SIZE = 25
// Run a few batches at once to keep large catalogs responsive without
// hammering the provider's rate limits.
const MAX_CONCURRENCY = 4

async function matchBatch(
  batch: ProductInput[],
  canonicalOptions: CanonicalInput[],
): Promise<AiMatch[]> {
  const payload = { products: batch, canonicalItems: canonicalOptions }
  const { output } = await generateText({
    model: 'google/gemini-2.5-flash',
    system: SYSTEM_PROMPT,
    output: Output.object({ schema: matchSchema }),
    messages: [
      {
        role: 'user',
        content: `Match these products to canonical items. Respond with one entry per product.\n\n${JSON.stringify(
          payload,
          null,
          2,
        )}`,
      },
    ],
  })
  return output.matches
}

export async function aiMatchProducts(
  productsToMatch: ProductInput[],
  canonicalOptions: CanonicalInput[],
): Promise<AiMatch[]> {
  if (productsToMatch.length === 0 || canonicalOptions.length === 0) {
    return []
  }

  // Split the products into fixed-size batches.
  const batches: ProductInput[][] = []
  for (let i = 0; i < productsToMatch.length; i += BATCH_SIZE) {
    batches.push(productsToMatch.slice(i, i + BATCH_SIZE))
  }

  const results: AiMatch[] = []
  // Process batches in small concurrent waves. A failed batch is skipped (its
  // products are simply left for the next run) rather than failing everything.
  for (let i = 0; i < batches.length; i += MAX_CONCURRENCY) {
    const wave = batches.slice(i, i + MAX_CONCURRENCY)
    const settled = await Promise.allSettled(
      wave.map((b) => matchBatch(b, canonicalOptions)),
    )
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(...s.value)
      } else {
        console.log('[v0] AI match batch failed:', s.reason?.message ?? s.reason)
      }
    }
  }

  return results
}
