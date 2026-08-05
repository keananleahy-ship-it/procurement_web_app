// Targeted, re-runnable backfill for the `subcategory` (formulation / base oil)
// column only. Designed so that pack-size variants of the SAME product always
// end up with the SAME formulation (the earlier per-item LLM pass classified
// each pack size independently and disagreed, e.g. one "DURON SHP 10W-30" size
// came back Conventional and another Synthetic Blend).
//
// Authority order, applied per non-human-edited row (recomputed from scratch so
// the script is idempotent):
//   1. Deterministic keyword rules on the row's OWN name (lib/attributes.ts).
//      A formulation word in the name (e.g. "SYN BLD") is the strongest signal
//      and is identical across a product's pack sizes, so it never splits a
//      group. This also corrects the old "SYN BLD -> Full Synthetic" mislabel.
//   2. For a matched product whose own name has no formulation word: inherit
//      the formulation of its canonical item. The canonical item is classified
//      ONCE per group, so every pack size under it agrees.
//   3. For an UNMATCHED product still without a formulation: a per-item LLM
//      guess (there is no group to keep consistent with).
// Canonical items themselves are resolved by rules first, then LLM for the rest
// (their descriptive names — "Synthetic Blend Heavy-Duty Engine Oil 10W-30" —
// make the rules very effective).
//
// Kept separate from derive-attributes.ts (which does a full overwrite) so it
// can't clobber LLM-filled brand/category/application/viscosity values.
//
// Run with:
//   node --env-file-if-exists=/vercel/share/.env.project scripts/backfill-formulation.ts
//   node --env-file-if-exists=/vercel/share/.env.project scripts/backfill-formulation.ts --no-llm
//
// Node 24 strips TypeScript types natively, so this .ts file runs directly.

import { Pool } from 'pg'
import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import * as z from 'zod'
import { deriveSubcategory, FORMULATION_LABELS } from '../lib/attributes.ts'

const connectionString =
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''

if (!connectionString) {
  console.error('[formulation] No DATABASE_URL / POSTGRES_URL in env')
  process.exit(1)
}

const pool = new Pool({ connectionString })

const NO_LLM = process.argv.includes('--no-llm')
const HAS_LLM = !NO_LLM && !!process.env.OPENAI_API_KEY
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
const LLM_MODEL = openai('gpt-5.4-mini')
const LLM_BATCH = 40
const LLM_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

const schema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      formulation: z
        .enum(FORMULATION_LABELS as [string, ...string[]])
        .nullable(),
    }),
  ),
})

type Result = { index: number; formulation: string | null }

const SYSTEM_PROMPT = `You are an expert on industrial and automotive lubricant products. For each product name, determine its base-oil formulation.

Return EXACTLY one of: ${FORMULATION_LABELS.join(', ')}, or null.
- "Full Synthetic": fully synthetic, PAO, ester, or a product line marketed as full synthetic (e.g. lines badged UHP / "Ultra", "Full Syn", "100% Synthetic").
- "Synthetic Blend": semi-synthetic / synthetic blend lines (e.g. badged "Syn Blend", or an "SHP" semi-synthetic line).
- "Conventional": mineral / conventional / paraffinic base oils.

Use your knowledge of the SPECIFIC product line and brand to infer the formulation even when the name does not literally say "synthetic". Only return null when you genuinely cannot determine it (e.g. a generic name with no line/spec signal, or a non-oil product). Do not invent values outside the allowed list. Return one result per input item, echoing its index.`

async function classify(
  items: { index: number; name: string }[],
): Promise<Result[]> {
  const list = items.map((i) => `${i.index}. ${i.name}`).join('\n')
  const { output } = await generateText({
    model: LLM_MODEL,
    output: Output.object({ schema }),
    system: SYSTEM_PROMPT,
    prompt: `Determine the formulation for these ${items.length} products:\n\n${list}`,
  })
  return output.results as Result[]
}

async function runPooled<T>(
  batches: T[],
  worker: (batch: T, i: number) => Promise<void>,
) {
  let cursor = 0
  async function next(): Promise<void> {
    const i = cursor++
    if (i >= batches.length) return
    await worker(batches[i], i)
    return next()
  }
  await Promise.all(
    Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, next),
  )
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Batch-LLM a set of {id, name} rows and write the returned formulation into
// `table`.subcategory (only where still null / non-edited).
async function llmFill(
  table: 'products' | 'canonical_items',
  rows: { id: number; name: string }[],
  label: string,
): Promise<void> {
  if (rows.length === 0) {
    console.log(`[formulation] ${label}: nothing to infer`)
    return
  }
  const indexed = rows.map((r, i) => ({ index: i, id: r.id, name: r.name }))
  const batches = chunk(indexed, LLM_BATCH)
  let filled = 0
  let done = 0
  await runPooled(batches, async (batch) => {
    try {
      const results = await classify(
        batch.map((b) => ({ index: b.index, name: b.name })),
      )
      const byIndex = new Map(results.map((r) => [r.index, r]))
      for (const item of batch) {
        const res = byIndex.get(item.index)
        if (!res || !res.formulation) continue
        await pool.query(
          `UPDATE ${table} SET subcategory = COALESCE(subcategory, $2)
           WHERE id = $1 AND "attributesEdited" = false`,
          [item.id, res.formulation],
        )
        filled++
      }
    } catch (e) {
      console.error(`[formulation] ${label} batch error:`, (e as Error).message)
    }
    done += batch.length
    console.log(`[formulation] ${label}: ${done}/${indexed.length} scanned, ${filled} filled`)
  })
  console.log(`[formulation] ${label}: filled ${filled}`)
}

// ---------------------------------------------------------------------------
// Canonical items: rules, then LLM for the rest
// ---------------------------------------------------------------------------

async function resolveCanonical(): Promise<void> {
  const { rows } = await pool.query<{
    id: number
    name: string
    subcategory: string | null
  }>(`
    SELECT id, name, subcategory FROM canonical_items
    WHERE "attributesEdited" = false
    ORDER BY id
  `)
  let corrected = 0
  for (const r of rows) {
    const det = deriveSubcategory(r.name)
    if (!det || det === r.subcategory) continue
    await pool.query(
      `UPDATE canonical_items SET subcategory = $2
       WHERE id = $1 AND "attributesEdited" = false`,
      [r.id, det],
    )
    corrected++
  }
  console.log(`[formulation] canonical deterministic: ${corrected} corrected`)

  if (!HAS_LLM) return
  const { rows: nullRows } = await pool.query<{ id: number; name: string }>(`
    SELECT id, name FROM canonical_items
    WHERE "attributesEdited" = false AND subcategory IS NULL
    ORDER BY id
  `)
  await llmFill('canonical_items', nullRows, 'canonical LLM')
}

// ---------------------------------------------------------------------------
// Products: own-name rules -> inherit canonical -> LLM (unmatched only)
// ---------------------------------------------------------------------------

async function resolveProducts(): Promise<void> {
  const { rows } = await pool.query<{
    id: number
    name: string
    subcategory: string | null
    canonicalItemId: number | null
    canonicalFormulation: string | null
  }>(`
    SELECT p.id, p.name, p.subcategory,
           p."canonicalItemId" AS "canonicalItemId",
           c.subcategory AS "canonicalFormulation"
    FROM products p
    LEFT JOIN canonical_items c ON c.id = p."canonicalItemId"
    WHERE p."attributesEdited" = false
    ORDER BY p.id
  `)

  let fromName = 0
  let inherited = 0
  let clearedForLlm = 0
  const needLlm: { id: number; name: string }[] = []

  for (const r of rows) {
    const det = deriveSubcategory(r.name)
    // Authority: own explicit name signal wins (identical across pack sizes).
    let target: string | null
    if (det) {
      target = det
      if (det !== r.subcategory) fromName++
    } else if (r.canonicalItemId && r.canonicalFormulation) {
      // Matched: inherit the group's single decision so pack sizes agree. This
      // also overwrites any inconsistent per-item value written earlier.
      target = r.canonicalFormulation
      if (r.canonicalFormulation !== r.subcategory) inherited++
    } else if (r.canonicalItemId) {
      // Matched but the canonical item has no formulation: keep the whole group
      // consistent at null rather than guessing per pack size.
      target = null
      if (r.subcategory !== null) clearedForLlm++
    } else {
      // Unmatched: a per-item LLM guess is fine (no group to stay aligned with).
      // Preserve any existing value; only the still-null ones go to the LLM.
      target = r.subcategory
      if (r.subcategory === null) needLlm.push({ id: r.id, name: r.name })
    }

    if (target !== r.subcategory) {
      await pool.query(
        `UPDATE products SET subcategory = $2
         WHERE id = $1 AND "attributesEdited" = false`,
        [r.id, target],
      )
    }
  }
  console.log(
    `[formulation] products: ${fromName} from name, ${inherited} inherited from canonical, ${clearedForLlm} cleared (matched, canonical null)`,
  )

  if (!HAS_LLM) {
    console.log(`[formulation] products: ${needLlm.length} unmatched left null (no LLM)`)
    return
  }
  await llmFill('products', needLlm, 'products LLM (unmatched)')
}

async function main() {
  try {
    // Canonical first so matched products can inherit a resolved value.
    await resolveCanonical()
    await resolveProducts()
    console.log('[formulation] complete')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[formulation] error', e)
  process.exit(1)
})
