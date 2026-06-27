import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import * as z from 'zod'

// Use the account's own OpenAI key directly rather than the AI Gateway. The
// gateway's zero-config tier is aggressively rate-limited (429s) regardless of
// available credits, which previously caused the whole AI match pass to fail
// with 0 suggestions. The direct provider uses paid OpenAI quota.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

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
      exclude: z
        .boolean()
        .describe(
          'True ONLY when a reviewer EXCLUSION RULE says this product is irrelevant and should be removed from price comparison entirely (e.g. an OEM-specific part). When true, canonicalItemId must be null.',
        ),
      reason: z
        .string()
        .describe(
          'A short (max ~120 char) human-readable justification for the match, non-match, or exclusion.',
        ),
    }),
  ),
})

export type AiMatch = z.infer<typeof matchSchema>['matches'][number]

export type ProductInput = {
  id: number
  name: string
  category: string | null
  unit: string | null
  baseUnit: string | null
}

export type CanonicalInput = {
  id: number
  name: string
  category: string | null
  baseUnit: string | null
}

// A past human rejection: the product, the canonical item that was wrongly
// suggested for it, and the reviewer's note explaining why it was wrong.
export type RejectionFeedback = {
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
- GRADE NUMBERS MUST MATCH EXACTLY. A numeric grade/viscosity designation is part of the item's identity, not a cosmetic variant. Two products are NOT the same canonical item unless their grade numbers are identical. This includes: ISO viscosity grade (ISO VG 22 ≠ 32 ≠ 46 ≠ 68 ≠ 100), SAE oil grades (SAE 30 ≠ 40; 15W-40 ≠ 10W-30; 80W-90 ≠ 85W-140), NLGI grease grades (NLGI 1 ≠ 2), AGMA grades, and any other numeric spec (bolt M8 ≠ M10, viscosity 320 ≠ 460). When the base product line matches but the grade number differs, return canonicalItemId null (or a different same-grade canonical), NOT the wrong-grade item. E.g. "P66 MEGAFLOW AW HYDRAULIC OIL 22" must NOT match a canonical "AW Hydraulic Oil ISO 46". Brand/series words being similar never outweigh a grade-number difference.
- confidence reflects how sure you are it is the same item: 0.9+ near-certain, 0.7-0.9 likely, 0.5-0.7 plausible, <0.5 doubtful.
- Return exactly one entry per product id provided. Keep each reason concise.
- Set exclude=false by default. Only set exclude=true when a reviewer rule (below) indicates the product is irrelevant and should be removed from comparison.

REVIEWER GUIDANCE (authoritative — overrides your own judgement):
You may be given REVIEWER FEEDBACK entries, each a product a human reviewed with a note explaining their decision. Treat every note as an authoritative rule and apply it broadly, not just to the one product it was attached to:
1. EXCLUSION RULES. If a note says a product (or a CLASS of products identified by a name fragment, brand, model, or OEM designation) is irrelevant, not for comparison, OEM-specific, or should be removed/ignored, then for EVERY product whose name matches that description — including products that were never individually reviewed — set exclude=true, canonicalItemId=null, and a reason citing the rule (e.g. "Excluded: reviewer rule — HRC Formula R is OEM-specific"). Apply this generally: e.g. a note "reject anything containing 'HRC Formula R' — OEM-specific" must exclude all such products.
2. PAIRING CORRECTIONS. Do NOT re-propose a product→canonical pairing a reviewer rejected. Generalize the distinction (e.g. if two grades or pack types were called different, keep similar products separate too).
When a product is covered by an exclusion rule, the exclusion takes precedence over any match you might otherwise propose.`

// The model must return one entry per product, so the response grows with the
// number of products in a single call. Sending the entire catalog at once
// overflows the model's output-token budget, the JSON gets truncated, and the
// structured output fails to parse (AI_NoOutputGeneratedError). Process the
// products in bounded batches so every call stays comfortably within limits.
export const MATCH_BATCH_SIZE = 20

// Split products into the batches the AI pass processes one at a time. Exposed
// so callers that want to report per-batch progress can size the work upfront.
export function buildMatchBatches(
  productsToMatch: ProductInput[],
): ProductInput[][] {
  const batches: ProductInput[][] = []
  for (let i = 0; i < productsToMatch.length; i += MATCH_BATCH_SIZE) {
    batches.push(productsToMatch.slice(i, i + MATCH_BATCH_SIZE))
  }
  return batches
}

export async function matchProductBatch(
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
    // Direct OpenAI provider (paid key) — see note at top of file.
    model: openai('gpt-5-mini'),
    system: SYSTEM_PROMPT,
    output: Output.object({ schema: matchSchema }),
    // 'low' reasoning keeps this catalog-classification task fast (high
    // reasoning roughly tripled per-batch latency, risking the route's time
    // limit on large catalogs) while still resolving synonyms and pack-size
    // variants well.
    providerOptions: { openai: { reasoningEffort: 'low' } },
    // High ceiling so the structured output for every product in the batch
    // fits without truncation.
    maxOutputTokens: 16000,
    messages: [
      {
        role: 'user',
        content: `Match these products to canonical items. Respond with one entry per product. The reviewerFeedback array holds authoritative reviewer notes: apply EXCLUSION rules (set exclude=true for every product matching the description) and never re-propose a rejected pairing.\n\n${JSON.stringify(
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

  // Run batches sequentially. Concurrent calls burst into provider rate limits
  // (especially on the free AI tier); going one at a time lets the SDK's
  // built-in exponential backoff absorb transient limits between batches.
  const batches = buildMatchBatches(productsToMatch)
  const results: AiMatch[] = []
  for (const batch of batches) {
    try {
      const matches = await matchProductBatch(batch, canonicalOptions, feedback)
      results.push(...matches)
    } catch (err) {
      // Isolate failures: a single bad batch shouldn't abort the whole run.
      // Its products simply stay unmatched and can be retried later.
      console.log('[v0] aiMatchProducts batch failed:', err)
    }
  }

  return results
}
