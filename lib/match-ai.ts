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

// A past human rejection: the product, the canonical item that was wrongly
// suggested for it, and the reviewer's note explaining why it was wrong.
type RejectionFeedback = {
  productName: string
  rejectedCanonicalName: string | null
  note: string
}

const SYSTEM_PROMPT = `You are a procurement catalog reconciliation assistant. You are given a list of vendor PRODUCTS (with ids) and a list of CANONICAL ITEMS (with ids). Match each product to the canonical item that represents the SAME underlying physical item, even when:
- Names use synonyms or different word order ("Protective Gloves" vs "Safety Gloves", "Steel Bolt M8" vs "M8 Steel Bolts").
- The product differs only by PACK SIZE or packaging while the contents are identical (a "box of 100 M8 bolts" and a single "M8 bolt" are the same canonical item; a "5 L jug of lubricant" and "lubricant per litre" are the same canonical item). Pack size must NOT prevent a match — items with identical contents in different pack sizes are the same canonical item.
- Grades/finishes that are functionally equivalent for procurement (e.g. "zinc plated" vs "galvanized") may match; genuinely different specs (different size, material, or grade that changes the part) should NOT match.

Rules:
- Only choose a canonicalItemId from the provided list. If no canonical item is a credible match, return canonicalItemId null with a low confidence and explain why.
- confidence reflects how sure you are it is the same item: 0.9+ near-certain, 0.7-0.9 likely, 0.5-0.7 plausible, <0.5 doubtful.
- Return exactly one entry per product id provided. Keep each reason concise.
- You may be given REVIEWER FEEDBACK: pairings a human already rejected, each with a note explaining why it was wrong. Treat this feedback as authoritative. Do NOT re-propose a product→canonical pairing the reviewer rejected. Generalize from the notes (e.g. if a reviewer said two grades or pack types are different, apply that distinction to similar products) to avoid repeating the same class of mistake.`

// The model must return one entry per product, so the response grows with the
// number of products in a single call. Sending the entire catalog at once
// overflows the model's output-token budget, the JSON gets truncated, and the
// structured output fails to parse (AI_NoOutputGeneratedError). Process the
// products in bounded batches so every call stays comfortably within limits.
const BATCH_SIZE = 20

async function matchBatch(
  batch: ProductInput[],
  canonicalOptions: CanonicalInput[],
  feedback: RejectionFeedback[],
): Promise<AiMatch[]> {
  const payload = {
    products: batch,
    canonicalItems: canonicalOptions,
    // Past human rejections the model must respect and learn from.
    reviewerFeedback: feedback.map((f) => ({
      product: f.productName,
      rejectedMatch: f.rejectedCanonicalName ?? '(no canonical item)',
      whyWrong: f.note,
    })),
  }

  const { output } = await generateText({
    // Anthropic models authenticate against the account's paid AI Gateway
    // credits. The Google/OpenAI models route through the gateway's free
    // zero-config tier, which is aggressively rate-limited (429s) regardless of
    // available credits — that was causing the AI pass to fail entirely.
    model: 'anthropic/claude-haiku-4.5',
    system: SYSTEM_PROMPT,
    output: Output.object({ schema: matchSchema }),
    // High ceiling so the structured output for every product in the batch
    // fits without truncation.
    maxOutputTokens: 16000,
    messages: [
      {
        role: 'user',
        content: `Match these products to canonical items. Respond with one entry per product. The reviewerFeedback array lists pairings a human already rejected and why — do not repeat them.\n\n${JSON.stringify(
          payload,
          null,
          2,
        )}`,
      },
    ],
  })

  return output?.matches ?? []
}

export async function aiMatchProducts(
  productsToMatch: ProductInput[],
  canonicalOptions: CanonicalInput[],
  feedback: RejectionFeedback[] = [],
): Promise<AiMatch[]> {
  if (productsToMatch.length === 0 || canonicalOptions.length === 0) {
    return []
  }

  // Split into batches and run them with limited concurrency. A failed batch is
  // isolated so it can't abort the whole run — its products simply go unmatched
  // and can be retried later.
  const batches: ProductInput[][] = []
  for (let i = 0; i < productsToMatch.length; i += BATCH_SIZE) {
    batches.push(productsToMatch.slice(i, i + BATCH_SIZE))
  }

  // Run batches sequentially. Concurrent calls burst into provider rate limits
  // (especially on the free AI tier); going one at a time lets the SDK's
  // built-in exponential backoff absorb transient limits between batches.
  const results: AiMatch[] = []
  for (const batch of batches) {
    try {
      const matches = await matchBatch(batch, canonicalOptions, feedback)
      results.push(...matches)
    } catch (err) {
      // Isolate failures: a single bad batch shouldn't abort the whole run.
      // Its products simply stay unmatched and can be retried later.
      console.log('[v0] aiMatchProducts batch failed:', err)
    }
  }

  return results
}
