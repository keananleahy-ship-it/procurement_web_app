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

const SYSTEM_PROMPT = `You are a procurement catalog reconciliation assistant for a price-comparison tool. Different vendors stock DIFFERENT BRANDS of the same kind of product, so you match on SPECIFICATION EQUIVALENCE, not brand. You are given a list of vendor PRODUCTS (with ids) and a list of CANONICAL ITEMS (with ids). Match each product to the canonical item describing the SAME specification, so competing vendor offerings can be compared head-to-head.

Two items are the SAME canonical specification when they share:
- Product kind/category (e.g. heavy-duty engine oil, hydraulic fluid, gear oil, grease, coolant).
- Viscosity grade (e.g. 15W-40, ISO 46, 80W-90) when applicable.
- Performance grade / spec class (e.g. API CK-4, API GL-5, DEXOS) when applicable.
- Base type when applicable (synthetic vs semi-synthetic vs conventional must NOT be mixed).

They match EVEN WHEN:
- The brand/manufacturer differs (Petro-Canada DURON vs Phillips66 GUARDOL are the SAME canonical item if their specs match).
- Names use synonyms or different word order.
- They differ only by PACK SIZE or container — pack size must NOT prevent a match.

They do NOT match when viscosity, performance grade, base type, or product kind differ.

Rules:
- Only choose a canonicalItemId from the provided list. If no canonical item shares the specification, return canonicalItemId null with low confidence and explain why.
- confidence reflects spec-equivalence certainty: 0.9+ specs clearly identical, 0.7-0.9 likely, 0.5-0.7 plausible, <0.5 doubtful.
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

// --- Spec extraction (canonical catalog seeding) ---------------------------
// To build a canonical catalog from scratch we derive a normalized SPEC for
// each product. Products that share the same spec are grouped into one
// canonical item so different-brand equivalents from different vendors compare
// head-to-head. The model returns structured fields; the deterministic
// grouping signature is built in code (see app/actions/canonical.ts) for
// stable cross-batch grouping.

const specSchema = z.object({
  specs: z.array(
    z.object({
      productId: z.number().describe('The id of the product being analyzed.'),
      productKind: z
        .string()
        .describe(
          'The normalized generic product category in lowercase, brand-free, e.g. "heavy-duty engine oil", "hydraulic fluid", "gear oil", "grease", "coolant", "atf". Required.',
        ),
      viscosity: z
        .string()
        .nullable()
        .describe(
          'Viscosity grade if applicable, normalized uppercase, e.g. "15W-40", "ISO 46", "80W-90". Null if not applicable.',
        ),
      performanceGrade: z
        .string()
        .nullable()
        .describe(
          'Performance/spec class if applicable, normalized uppercase, e.g. "CK-4", "GL-5", "DEXOS". Null if none.',
        ),
      baseType: z
        .enum(['synthetic', 'semi-synthetic', 'conventional', 'unknown'])
        .describe(
          'Base type for lubricants. Use "unknown" when not stated or not applicable.',
        ),
      displayName: z
        .string()
        .describe(
          'A concise brand-free canonical name for this spec, e.g. "Heavy-Duty Engine Oil 15W-40 CK-4 (Conventional)".',
        ),
    }),
  ),
})

export type AiSpec = z.infer<typeof specSchema>['specs'][number]

const SPEC_SYSTEM_PROMPT = `You are a procurement catalog normalizer. For each vendor PRODUCT you are given, extract its brand-free SPECIFICATION so that equivalent products from different brands/vendors can be grouped for price comparison.

For each product return:
- productKind: the generic, brand-free category (lowercase). Examples: "heavy-duty engine oil", "passenger car motor oil", "hydraulic fluid", "gear oil", "grease", "coolant/antifreeze", "automatic transmission fluid", "def".
- viscosity: the viscosity grade if present (e.g. "15W-40", "5W-30", "ISO 46", "80W-90"), else null.
- performanceGrade: the performance/spec class if present (e.g. "CK-4", "CJ-4", "SN", "GL-5"), else null.
- baseType: synthetic, semi-synthetic, conventional, or unknown.
- displayName: a short brand-free name combining the above.

Ignore brand names, vendor names, marketing words, and pack/container sizes. Two products with the same productKind + viscosity + performanceGrade + baseType are the SAME specification regardless of brand. Return exactly one entry per product id.`

async function specBatch(batch: ProductInput[]): Promise<AiSpec[]> {
  const { output } = await generateText({
    model: 'google/gemini-2.5-flash',
    system: SPEC_SYSTEM_PROMPT,
    output: Output.object({ schema: specSchema }),
    messages: [
      {
        role: 'user',
        content: `Extract the specification for each product. Respond with one entry per product.\n\n${JSON.stringify(
          { products: batch },
          null,
          2,
        )}`,
      },
    ],
  })
  return output.specs
}

export async function aiDeriveSpecs(
  productsToAnalyze: ProductInput[],
): Promise<AiSpec[]> {
  if (productsToAnalyze.length === 0) return []

  const batches: ProductInput[][] = []
  for (let i = 0; i < productsToAnalyze.length; i += BATCH_SIZE) {
    batches.push(productsToAnalyze.slice(i, i + BATCH_SIZE))
  }

  const results: AiSpec[] = []
  for (let i = 0; i < batches.length; i += MAX_CONCURRENCY) {
    const wave = batches.slice(i, i + MAX_CONCURRENCY)
    const settled = await Promise.allSettled(wave.map((b) => specBatch(b)))
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(...s.value)
      } else {
        console.log('[v0] AI spec batch failed:', s.reason?.message ?? s.reason)
      }
    }
  }

  return results
}
