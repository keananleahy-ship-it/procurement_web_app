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

CRITICAL: productKind and viscosity are the grouping keys. They MUST be phrased identically for equivalent products so they group together. Be consistent and terse.

- productKind: choose the SINGLE best match from this controlled list (lowercase, exact spelling). Use the closest one; only invent a new term if none fits:
  "heavy-duty engine oil", "passenger car motor oil", "hydraulic fluid", "gear oil", "automatic transmission fluid", "transmission fluid", "grease", "coolant", "gasoline engine oil", "natural gas engine oil", "compressor oil", "turbine oil", "rock drill oil", "way oil", "spindle oil", "r&o oil", "circulating oil", "chain oil", "tractor fluid", "2-cycle oil", "marine engine oil", "aviation oil", "metalworking fluid", "open gear lubricant", "def", "solvent", "brake fluid", "industrial oil".
  Treat "diesel engine oil", "fleet oil", "HDMO", "HDEO" all as "heavy-duty engine oil". Treat "ATF" as "automatic transmission fluid".
- viscosity: normalize to canonical form. Engine/gear oils use SAE like "15W-40", "5W-30", "80W-90" (always with the dash, uppercase W). Industrial oils use "ISO 46", "ISO 100" (space, no leading zeros). Greases use NLGI like "NLGI 2". If none applies, null.
- performanceGrade: the performance/spec class if explicitly present (e.g. "CK-4", "CJ-4", "SN", "GL-5"), else null. Do NOT guess.
- baseType: only if explicitly indicated (synthetic, semi-synthetic, conventional); otherwise "unknown". Do NOT guess.
- displayName: a short brand-free name, e.g. "Heavy-Duty Engine Oil 15W-40".

Ignore brand names, vendor names, marketing words, and pack/container sizes. Two products with the same productKind + viscosity are the same group regardless of brand. Return exactly one entry per product id — never skip a product.`

// Spec extraction uses a smaller batch than matching: large structured-output
// batches frequently truncate or return fewer entries than requested, which
// previously dropped the majority of products silently.
const SPEC_BATCH_SIZE = 12

async function specBatchOnce(batch: ProductInput[]): Promise<AiSpec[]> {
  const { output } = await generateText({
    model: 'google/gemini-2.5-flash',
    system: SPEC_SYSTEM_PROMPT,
    output: Output.object({ schema: specSchema }),
    messages: [
      {
        role: 'user',
        content: `Extract the specification for each of these ${batch.length} products. Respond with EXACTLY one entry per product id — do not skip any.\n\n${JSON.stringify(
          { products: batch },
          null,
          2,
        )}`,
      },
    ],
  })
  return output.specs
}

// Run a batch and guarantee coverage: retry once for the whole batch on error,
// then retry any individual products the model omitted. Returns specs for as
// many of the batch's products as possible.
async function specBatch(batch: ProductInput[]): Promise<AiSpec[]> {
  let specs: AiSpec[] = []
  try {
    specs = await specBatchOnce(batch)
  } catch (err) {
    console.log('[v0] spec batch error, retrying:', (err as Error)?.message)
    try {
      specs = await specBatchOnce(batch)
    } catch (err2) {
      console.log('[v0] spec batch retry failed:', (err2 as Error)?.message)
      specs = []
    }
  }

  // Find products the model dropped and retry just those in one smaller call.
  const have = new Set(specs.map((s) => s.productId))
  const missing = batch.filter((p) => !have.has(p.id))
  if (missing.length > 0) {
    try {
      const retried = await specBatchOnce(missing)
      const haveNow = new Set(specs.map((s) => s.productId))
      for (const s of retried) if (!haveNow.has(s.productId)) specs.push(s)
    } catch (err) {
      console.log('[v0] spec missing-retry failed:', (err as Error)?.message)
    }
  }

  return specs
}

export async function aiDeriveSpecs(
  productsToAnalyze: ProductInput[],
): Promise<AiSpec[]> {
  if (productsToAnalyze.length === 0) return []

  const batches: ProductInput[][] = []
  for (let i = 0; i < productsToAnalyze.length; i += SPEC_BATCH_SIZE) {
    batches.push(productsToAnalyze.slice(i, i + SPEC_BATCH_SIZE))
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
