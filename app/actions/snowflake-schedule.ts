'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { snowflakeConnection } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/roles'
import {
  AUTO_PULL_FREQUENCIES,
  type AutoPullFrequency,
  normalizeFrequency,
} from '@/lib/auto-pull-schedule'

export type AutoPullSettings = {
  frequency: AutoPullFrequency
  weekday: number
  monthDay: number
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  lastOk: boolean | null
  lastMessage: string | null
}

export async function getAutoPullSettings(): Promise<AutoPullSettings | null> {
  await requireAdmin()
  const [row] = await db
    .select()
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)
  if (!row) return null
  return {
    frequency: normalizeFrequency(row.autoPullFrequency),
    weekday: row.autoPullWeekday,
    monthDay: row.autoPullMonthDay,
    lastSuccessAt: row.lastAutoPullAt?.toISOString() ?? null,
    lastAttemptAt: row.autoPullStartedAt?.toISOString() ?? null,
    lastOk: row.lastAutoPullOk,
    lastMessage: row.lastAutoPullMessage,
  }
}

const scheduleSchema = z.object({
  frequency: z.enum(AUTO_PULL_FREQUENCIES),
  weekday: z.number().int().min(0).max(6),
  // Capped at 28 so every month has the chosen day.
  monthDay: z.number().int().min(1).max(28),
})

export async function saveAutoPullSchedule(
  input: z.infer<typeof scheduleSchema>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = await requireAdmin()
  const parsed = scheduleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Invalid schedule.' }

  const updated = await db
    .update(snowflakeConnection)
    .set({
      autoPullFrequency: parsed.data.frequency,
      autoPullWeekday: parsed.data.weekday,
      autoPullMonthDay: parsed.data.monthDay,
      autoPullUserId: admin.id,
    })
    .where(eq(snowflakeConnection.id, 1))
    .returning({ id: snowflakeConnection.id })
  if (updated.length === 0) {
    return { ok: false, message: 'Connect Snowflake before scheduling pulls.' }
  }
  revalidatePath('/data-sources')
  return { ok: true }
}
