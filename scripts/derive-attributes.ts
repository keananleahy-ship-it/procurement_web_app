// One-time / re-runnable backfill that derives the hierarchy attributes
// (brand, category, application, subcategory=formulation, viscosity,
// packageType, supplier) for every product and canonical item from its name +
// pack size.
//
// Two passes:
//   1. Deterministic keyword rules (lib/attributes.ts) — fast, free, covers the
//      bulk of plainly-named items.
//   2. LLM fallback — only for rows the rules left with a null brand or
//      category (coded product-line names like Shell "Gadus"/"Spirax" and
//      cryptic SKUs the rules can't catch). Fills ONLY still-null fields, so a
//      deterministic value is never overwritten. Skip with --no-llm.
//
// Rows a reviewer hand-corrected (attributesEdited = true) are skipped in both
// passes so a re-run never clobbers manual fixes.
//
// Run with:
//   node --env-file-if-exists=/vercel/share/.env.project scripts/derive-attributes.ts
//   node --env-file-if-exists=/vercel/share/.env.project scripts/derive-attributes.ts --no-llm
//
// Node 24 strips TypeScript types natively, so this .ts file runs directly.

import { Pool } from 'pg'
import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import * as z from 'zod'
import {
  deriveAttributes,
  CATEGORY_LABELS,
  APPLICATION_LABELS,
  FORMULATION_LABELS,
  KNOWN_BRAND_LABELS,
} from '../lib/attributes.ts'

const connectionString =
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''

if (!connectionString) {
  console.error('[derive] No DATABASE_URL / POSTGRES_URL in env')
  process.exit(1)
}

const pool = new Pool({ connectionString })

const NO_LLM = process.argv.includes('--no-llm')
// The project's AI_GATEWAY_API_KEY is actually an OpenAI key (sk-...), not a
// Vercel Gateway key (vck_...), so the Gateway rejects it. Use the OpenAI
// provider directly with OPENAI_API_KEY instead.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
const LLM_MODEL = openai('gpt-5.4-mini')
const LLM_BATCH = 40
const LLM_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// Pass 1: deterministic keyword rules
// ---------------------------------------------------------------------------

async function deriveProducts() {
  const { rows } = await pool.query<{
    id: number
    name: string
    packSize: string | null
    supplier: string | null
  }>(`
    SELECT p.id, p.name, p."packSize",
           (
             SELECT ven.name
             FROM vendor_prices vp
             JOIN vendors ven ON ven.id = vp."vendorId"
             WHERE vp."productId" = p.id
             LIMIT 1
           ) AS supplier
    FROM products p
    WHERE p."attributesEdited" = false
    ORDER BY p.id
  `)

  console.log(`[derive] products to process: ${rows.length}`)
  let n = 0
  for (const r of rows) {
    const packSize = r.packSize != null ? Number(r.packSize) : undefined
    const a = deriveAttributes(r.name, packSize)
    await pool.query(
      `UPDATE products
         SET brand = $2,
             category = $3,
             application = $4,
             subcategory = $5,
             viscosity = $6,
             "packageType" = $7,
             supplier = $8
       WHERE id = $1`,
      [
        r.id,
        a.brand,
        a.category,
        a.application,
        a.subcategory,
        a.viscosity,
        a.packageType,
        r.supplier,
      ],
    )
    if (++n % 250 === 0) console.log(`[derive]   products ${n}/${rows.length}`)
  }
  console.log(`[derive] products done: ${n}`)
}

async function deriveCanonical() {
  const { rows } = await pool.query<{ id: number; name: string }>(`
    SELECT id, name FROM canonical_items
    WHERE "attributesEdited" = false
    ORDER BY id
  `)

  console.log(`[derive] canonical items to process: ${rows.length}`)
  let n = 0
  for (const r of rows) {
    const a = deriveAttributes(r.name)
    await pool.query(
      `UPDATE canonical_items
         SET category = $2,
             application = $3,
             subcategory = $4,
             viscosity = $5
       WHERE id = $1`,
      [r.id, a.category, a.application, a.subcategory, a.viscosity],
    )
    n++
  }
  console.log(`[derive] canonical items done: ${n}`)
}

// ---------------------------------------------------------------------------
// Pass 2: LLM fallback for coded / cryptic names
// ---------------------------------------------------------------------------

// Enums keep the model's category/application within the SAME controlled
// vocabulary the rules use, so buckets stay consistent. Brand is open-ended so
// the model can recognize brands not yet in the dictionary. nullable() (not
// optional()) is required for OpenAI strict mode.
const classificationSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      brand: z.string().nullable(),
      category: z
        .enum(CATEGORY_LABELS as [string, ...string[]])
        .nullable(),
      application: z
        .enum(APPLICATION_LABELS as [string, ...string[]])
        .nullable(),
      formulation: z
        .enum(FORMULATION_LABELS as [string, ...string[]])
        .nullable(),
    }),
  ),
})

type Classification = {
  index: number
  brand: string | null
  category: string | null
  application: string | null
  formulation: string | null
}

const SYSTEM_PROMPT = `You classify product names from a distributor of industrial and automotive lubricants (engine oils, hydraulic/gear/turbine/compressor oils, greases, coolants, transmission fluids, etc.).

For each item, return:
- brand: the manufacturer or parent brand. Map product lines to their parent brand (e.g. Rotella/Gadus/Spirax/Tellus -> "Shell"; Duron/Traxon/Hydrex -> "Petro-Canada"; Delo -> "Chevron"; Delvac -> "Mobil"). Prefer these known brands when applicable: ${KNOWN_BRAND_LABELS.join(', ')}. If you confidently recognize another real brand (e.g. Kubota, John Deere, Case IH, Prestone), return it. Otherwise null.
- category: EXACTLY one of the allowed categories, or null if it is not a lubricant/fluid we categorize (e.g. oil/air/fuel filters, DEF/diesel exhaust fluid, shop supplies, cleaners) or you cannot tell.
- application: the end-use/duty, EXACTLY one of the allowed applications, or null if not determinable. Use "Industrial" for plant machinery lubricants (hydraulic, gear, turbine, compressor, circulating, grease).
- formulation: the base-oil type, EXACTLY one of the allowed formulations, or null if not stated/inferable. "Full Synthetic" for fully synthetic/PAO/ester oils, "Synthetic Blend" for semi-synthetic blends, "Conventional" for mineral/conventional oils.

Allowed categories: ${CATEGORY_LABELS.join(', ')}.
Allowed applications: ${APPLICATION_LABELS.join(', ')}.
Allowed formulations: ${FORMULATION_LABELS.join(', ')}.

Rules: Do not invent values outside the allowed lists. When unsure, use null rather than guessing. Return one result object per input item, echoing its index.`

async function classifyBatch(
  items: { index: number; name: string }[],
): Promise<Classification[]> {
  const list = items.map((i) => `${i.index}. ${i.name}`).join('\n')
  const { output } = await generateText({
    model: LLM_MODEL,
    output: Output.object({ schema: classificationSchema }),
    system: SYSTEM_PROMPT,
    prompt: `Classify these ${items.length} product names:\n\n${list}`,
  })
  return output.results as Classification[]
}

// Run async workers over batches with bounded concurrency.
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

async function llmBackfillProducts() {
  const { rows } = await pool.query<{ id: number; name: string }>(`
    SELECT id, name FROM products
    WHERE "attributesEdited" = false
      AND (category IS NULL OR brand IS NULL
           OR application IS NULL OR subcategory IS NULL)
    ORDER BY id
  `)
  if (rows.length === 0) {
    console.log('[derive] LLM products: nothing to backfill')
    return
  }
  console.log(`[derive] LLM products to classify: ${rows.length}`)
  const byIndex = new Map(rows.map((r, i) => [i, r]))
  const items = rows.map((r, i) => ({ index: i, name: r.name }))
  const batches = chunk(items, LLM_BATCH)

  let filled = 0
  let done = 0
  await runPooled(batches, async (batch) => {
    let results: Classification[] = []
    try {
      results = await classifyBatch(batch)
    } catch (err) {
      console.error(
        `[derive]   LLM batch failed (${(err as Error).message}); skipping`,
      )
    }
    for (const res of results) {
      const row = byIndex.get(res.index)
      if (!row) continue
      // COALESCE keeps any value the deterministic pass already set; the LLM
      // only fills genuine nulls.
      await pool.query(
        `UPDATE products
           SET brand = COALESCE(brand, $2),
               category = COALESCE(category, $3),
               application = COALESCE(application, $4),
               subcategory = COALESCE(subcategory, $5)
         WHERE id = $1 AND "attributesEdited" = false`,
        [row.id, res.brand, res.category, res.application, res.formulation],
      )
      filled++
    }
    done += batch.length
    console.log(`[derive]   LLM products ${done}/${rows.length}`)
  })
  console.log(`[derive] LLM products done: updated ${filled} rows`)
}

async function llmBackfillCanonical() {
  const { rows } = await pool.query<{ id: number; name: string }>(`
    SELECT id, name FROM canonical_items
    WHERE "attributesEdited" = false
      AND (category IS NULL OR application IS NULL OR subcategory IS NULL)
    ORDER BY id
  `)
  if (rows.length === 0) {
    console.log('[derive] LLM canonical: nothing to backfill')
    return
  }
  console.log(`[derive] LLM canonical to classify: ${rows.length}`)
  const byIndex = new Map(rows.map((r, i) => [i, r]))
  const items = rows.map((r, i) => ({ index: i, name: r.name }))
  const batches = chunk(items, LLM_BATCH)

  let filled = 0
  await runPooled(batches, async (batch) => {
    let results: Classification[] = []
    try {
      results = await classifyBatch(batch)
    } catch (err) {
      console.error(
        `[derive]   LLM batch failed (${(err as Error).message}); skipping`,
      )
    }
    for (const res of results) {
      const row = byIndex.get(res.index)
      if (!row) continue
      await pool.query(
        `UPDATE canonical_items
           SET category = COALESCE(category, $2),
               application = COALESCE(application, $3),
               subcategory = COALESCE(subcategory, $4)
         WHERE id = $1 AND "attributesEdited" = false`,
        [row.id, res.category, res.application, res.formulation],
      )
      filled++
    }
  })
  console.log(`[derive] LLM canonical done: updated ${filled} rows`)
}

async function main() {
  try {
    await deriveProducts()
    await deriveCanonical()
    if (NO_LLM) {
      console.log('[derive] --no-llm set, skipping LLM fallback')
    } else if (!process.env.OPENAI_API_KEY) {
      console.log('[derive] no OPENAI_API_KEY, skipping LLM fallback')
    } else {
      await llmBackfillProducts()
      await llmBackfillCanonical()
    }
    console.log('[derive] complete')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[derive] failed:', err)
  process.exit(1)
})
