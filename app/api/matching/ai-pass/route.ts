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

      for (let i = 0; i < batches.length; i++) {
        // Stop spending credits if the client navigated away / aborted the
        // request. Any products already updated keep their new status.
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

        const batch = batches[i]
        try {
          const matches = await matchProductBatch(
            batch,
            canonicalOptions,
            feedback,
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

        productsDone += batch.length
        send({
          type: 'progress',
          batchesDone: i + 1,
          totalBatches: batches.length,
          productsDone,
          totalProducts: pending.length,
          suggested,
          cleared,
          skipped,
          excluded,
        })
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
    },
  })
}
