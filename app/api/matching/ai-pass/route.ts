import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { getCurrentUser, canEdit } from '@/lib/roles'
import { db } from '@/lib/db'
import { canonicalItems, products, matchRejectionFeedback } from '@/lib/db/schema'
import {
  buildMatchBatches,
  matchProductBatch,
  type CanonicalInput,
  type RejectionFeedback,
} from '@/lib/match-ai'

export const maxDuration = 300

// Per-batch ceiling. Normal batches return in ~10-20s; if one stalls past this
// we abort it (counted as skipped) so the worker pool can finish and the
// stream always closes instead of hanging open.
const BATCH_TIMEOUT_MS = 90_000

// Streaming AI match pass. Mirrors the generateAiSuggestions server action but
// emits newline-delimited JSON progress events per batch so the client can show
// a real, determinate progress bar instead of an indeterminate spinner.
export async function POST(req: Request) {
  const current = await getCurrentUser()
  if (!current) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canEdit(current.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [items, prods, feedbackRows] = await Promise.all([
    db.select().from(canonicalItems),
    db.select().from(products),
    db
      .select()
      .from(matchRejectionFeedback)
      .orderBy(desc(matchRejectionFeedback.createdAt))
      .limit(200),
  ])

  const canonicalOptions: CanonicalInput[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    baseUnit: i.baseUnit,
  }))
  const validCanonicalIds = new Set(canonicalOptions.map((c) => c.id))
  const feedback: RejectionFeedback[] = feedbackRows.map((f) => ({
    productName: f.productName,
    rejectedCanonicalName: f.canonicalItemName,
    note: f.note,
  }))

  // Only reconsider products the user has not already decided on. Confirmed,
  // rejected, and excluded products are settled decisions and left untouched.
  const pending = prods.filter(
    (p) =>
      p.matchStatus !== 'confirmed' &&
      p.matchStatus !== 'rejected' &&
      p.matchStatus !== 'excluded',
  )

  const batches = buildMatchBatches(
    pending.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      unit: p.unit,
      baseUnit: p.baseUnit,
    })),
  )
  const pendingById = new Map(pending.map((p) => [p.id, p]))

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))

      let suggested = 0
      let cleared = 0
      let skipped = 0
      let excluded = 0
      let productsDone = 0

      send({
        type: 'start',
        totalBatches: batches.length,
        totalProducts: pending.length,
      })

      if (batches.length === 0 || canonicalOptions.length === 0) {
        send({ type: 'done', suggested, cleared, skipped, excluded })
        controller.close()
        return
      }

      // Process one batch: run the AI call and apply per-product DB updates,
      // mutating the shared counters. Isolated so a single batch failure (e.g.
      // a transient rate limit) leaves its products untouched and never aborts
      // the run. Counter mutations are safe under concurrency because JS runs
      // them synchronously between awaits on a single thread.
      const processBatch = async (batch: typeof batches[number]) => {
        // Bound every batch so a stalled OpenAI socket can't hang the run.
        // A normal batch returns in ~10-20s; 90s is a generous ceiling after
        // which we abort, count the batch as skipped, and move on. Also abort
        // if the client navigated away (req.signal).
        const timeout = AbortSignal.timeout(BATCH_TIMEOUT_MS)
        const signal = AbortSignal.any([req.signal, timeout])
        try {
          const matches = await matchProductBatch(
            batch,
            canonicalOptions,
            feedback,
            signal,
          )
          const byId = new Map(matches.map((m) => [m.productId, m]))

          for (const bp of batch) {
            const p = pendingById.get(bp.id)
            if (!p) continue
            const m = byId.get(bp.id)
            // No entry => treat as skipped; don't wipe an existing match.
            if (!m) {
              skipped++
              continue
            }

            // A reviewer exclusion rule applies: drop from comparison entirely.
            if (m.exclude) {
              await db
                .update(products)
                .set({
                  canonicalItemId: null,
                  matchStatus: 'excluded',
                  matchScore: null,
                  matchMethod: 'ai',
                  matchReason:
                    m.reason?.slice(0, 280) ?? 'Excluded by reviewer rule',
                })
                .where(eq(products.id, p.id))
              excluded++
              continue
            }

            const hasMatch =
              m.canonicalItemId !== null &&
              validCanonicalIds.has(m.canonicalItemId) &&
              m.confidence >= 0.5

            if (hasMatch) {
              await db
                .update(products)
                .set({
                  canonicalItemId: m.canonicalItemId,
                  matchStatus: 'suggested',
                  matchScore: Math.max(0, Math.min(1, m.confidence)).toFixed(4),
                  matchMethod: 'ai',
                  matchReason: m.reason?.slice(0, 280) ?? null,
                })
                .where(eq(products.id, p.id))
              suggested++
            } else {
              await db
                .update(products)
                .set({
                  canonicalItemId: null,
                  matchStatus: 'unmatched',
                  matchScore: null,
                  matchMethod: 'ai',
                  matchReason: m.reason?.slice(0, 280) ?? null,
                })
                .where(eq(products.id, p.id))
              cleared++
            }
          }
        } catch (err) {
          // Isolate batch failures (e.g. a transient rate limit): leave those
          // products untouched and keep going.
          console.log('[v0] ai-pass batch failed:', err)
          skipped += batch.length
        }
      }

      // Run batches through a small worker pool. The direct OpenAI provider
      // tolerates modest concurrency, so this keeps a large catalog (~80
      // batches) comfortably inside maxDuration instead of timing out at the
      // tail. Each completed batch streams a progress event; the abort signal
      // is checked before claiming each new batch so navigating away stops
      // further spend while preserving everything already written.
      // 12-wide pool keeps a full ~80-batch catalog around ~3 min — a safe
      // margin under maxDuration (300s) — while staying within the OpenAI
      // per-minute token budget. Was 8, which let large runs creep toward the
      // 5-minute limit and risk being killed mid-stream.
      const CONCURRENCY = 12
      let cursor = 0
      let batchesDone = 0

      const worker = async () => {
        for (;;) {
          if (req.signal.aborted) return
          const i = cursor++
          if (i >= batches.length) return
          await processBatch(batches[i])
          batchesDone++
          productsDone += batches[i].length
          send({
            type: 'progress',
            batchesDone,
            totalBatches: batches.length,
            productsDone,
            totalProducts: pending.length,
            suggested,
            cleared,
            skipped,
            excluded,
          })
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker),
      )

      if (req.signal.aborted) {
        revalidatePath('/matching')
        revalidatePath('/compare')
        revalidatePath('/')
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }

      revalidatePath('/matching')
      revalidatePath('/compare')
      revalidatePath('/')

      send({ type: 'done', suggested, cleared, skipped, excluded })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Disable proxy/CDN buffering (nginx, the v0 preview proxy, etc.).
      // Without this the per-batch progress events get held back and delivered
      // in one burst at the end, so the bar appears frozen at ~5% for minutes
      // even though the pass is actively running.
      'X-Accel-Buffering': 'no',
    },
  })
}
