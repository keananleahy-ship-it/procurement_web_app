import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import * as z from 'zod'
import {
  type AttributeKey,
  VALIDATION_ATTRIBUTE_KEYS,
  vocabularyFor,
} from './attributes'

// Direct OpenAI provider (same rationale as lib/match-ai.ts): the AI Gateway's
// zero-config tier is rate-limited, so use the account's paid OpenAI quota.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const ATTRIBUTE_FILL_MODEL = 'gpt-5-mini'

// A product whose MISSING attributes we want the AI to propose. Only the empty
// attributes are requested; already-set values are passed as context so the AI
// stays consistent with them but never overwrites them.
export type AttributeFillInput = {
  productId: number
  name: string
  packSize: number | null
  baseUnit: string | null
  // Currently-set attribute values (may be null). The AI treats these as fixed.
  current: Record<AttributeKey, string | null>
  // The subset of VALIDATION_ATTRIBUTE_KEYS that are empty and need a proposal.
  missing: AttributeKey[]
}

export type AttributeSuggestion = {
  productId: number
  attribute: AttributeKey
  value: string
  confidence: number
  rationale: string
}

const suggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      productId: z.number().describe('The id of the product.'),
      attribute: z
        .string()
        .describe(
          'One of: ' + VALIDATION_ATTRIBUTE_KEYS.join(', ') + '.',
        ),
      value: z
        .string()
        .describe(
          'The proposed value. For attributes with a controlled vocabulary it MUST be one of the allowed values provided.',
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence 0..1 that this value is correct.'),
      rationale: z
        .string()
        .describe('A short (<= 12 word) justification citing the evidence.'),
    }),
  ),
})

// Human-readable label + allowed vocabulary block for the prompt.
function attributeGuide(category: string | null): string {
  const lines: string[] = []
  for (const key of VALIDATION_ATTRIBUTE_KEYS) {
    const vocab = vocabularyFor(key, category)
    if (vocab && vocab.length) {
      lines.push(`- ${key}: choose EXACTLY one of [${vocab.join(' | ')}]`)
    } else if (key === 'viscosity') {
      lines.push(
        `- viscosity: the SAE/ISO grade exactly as it would be written (e.g. "15W-40", "ISO 68", "80W-90"), or omit if not applicable`,
      )
    } else if (key === 'supplier') {
      lines.push(
        `- supplier: the manufacturer / brand owner (e.g. "CITGO", "Sunoco", "Mystik"), or omit if unknown`,
      )
    }
  }
  return lines.join('\n')
}

// Propose values for the MISSING attributes of a batch of products. Returns one
// suggestion per (product, attribute) pair, already validated against the
// controlled vocabulary — anything the model returns for a select attribute
// that isn't in the vocabulary is dropped (never coerced), so a champion never
// sees an out-of-vocabulary suggestion. This never touches the database.
export async function suggestAttributes(
  products: AttributeFillInput[],
): Promise<AttributeSuggestion[]> {
  const targets = products.filter((p) => p.missing.length > 0)
  if (targets.length === 0) return []

  const productBlocks = targets
    .map((p) => {
      const currentPairs = VALIDATION_ATTRIBUTE_KEYS.filter(
        (k) => p.current[k],
      )
        .map((k) => `${k}=${p.current[k]}`)
        .join(', ')
      const pack =
        p.packSize != null
          ? `${p.packSize}${p.baseUnit ? ' ' + p.baseUnit : ''}`
          : 'unknown'
      return [
        `productId ${p.productId}: "${p.name}"`,
        `  pack: ${pack}`,
        currentPairs ? `  known: ${currentPairs}` : `  known: (none)`,
        `  fill: ${p.missing.join(', ')}`,
      ].join('\n')
    })
    .join('\n\n')

  // Use the first target's category (if any) to scope the formulation vocab in
  // the guide. The per-suggestion validation below re-checks each product's own
  // category, so this only affects prompt guidance, not correctness.
  const guide = attributeGuide(targets[0].current.category ?? null)

  const { output } = await generateText({
    model: openai(ATTRIBUTE_FILL_MODEL),
    experimental_output: Output.object({ schema: suggestionSchema }),
    prompt: `You are a petroleum-products catalog analyst. For each product below, propose values ONLY for the attributes listed after "fill:". Base every value strictly on the product name, pack size, and the known attributes — do not invent specifications you cannot infer from the text. If you cannot infer an attribute with reasonable confidence, omit it rather than guessing.

Attribute rules:
${guide}

Do NOT propose a value for any attribute not in a product's "fill:" list. Return one entry per (productId, attribute) you are confident about.

Products:
${productBlocks}`,
  })

  const raw = output?.suggestions ?? []
  const byId = new Map(targets.map((t) => [t.productId, t]))
  const out: AttributeSuggestion[] = []
  const seen = new Set<string>()

  for (const s of raw) {
    const target = byId.get(s.productId)
    if (!target) continue
    const key = s.attribute as AttributeKey
    // Must be a validation attribute the product actually asked to fill.
    if (!VALIDATION_ATTRIBUTE_KEYS.includes(key)) continue
    if (!target.missing.includes(key)) continue
    const value = (s.value ?? '').trim()
    if (!value) continue
    // Enforce the controlled vocabulary for select attributes, scoped to the
    // product's own (possibly just-suggested) category is out of scope here —
    // we validate against its currently-known category.
    const vocab = vocabularyFor(key, target.current.category)
    if (vocab && !vocab.includes(value)) continue
    const dedupe = `${s.productId}:${key}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push({
      productId: s.productId,
      attribute: key,
      value,
      confidence: Math.max(0, Math.min(1, s.confidence ?? 0)),
      rationale: (s.rationale ?? '').trim(),
    })
  }
  return out
}
