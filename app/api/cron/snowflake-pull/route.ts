import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { snowflakeConnection, user } from '@/lib/db/schema'
import { type Role, canAdmin } from '@/lib/roles-shared'
import { isAutoPullDue, normalizeFrequency } from '@/lib/auto-pull-schedule'
import { runSnowflakePull } from '@/lib/snowflake-pull'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function finish(ok: boolean, message: string, success: boolean) {
  await db
    .update(snowflakeConnection)
    .set({
      lastAutoPullOk: ok,
      lastAutoPullMessage: message,
      ...(success ? { lastAutoPullAt: new Date() } : {}),
    })
    .where(eq(snowflakeConnection.id, 1))
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [conn] = await db
    .select()
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)
  if (!conn) return NextResponse.json({ ran: false, reason: 'No Snowflake connection.' })

  const schedule = {
    frequency: normalizeFrequency(conn.autoPullFrequency),
    weekday: conn.autoPullWeekday,
    monthDay: conn.autoPullMonthDay,
  }
  const now = new Date()
  if (!isAutoPullDue(schedule, conn.lastAutoPullAt, now)) {
    return NextResponse.json({ ran: false, reason: 'Not due.' })
  }

  // Claim the run so overlapping invocations can't stage duplicate imports.
  const claimed = await db
    .update(snowflakeConnection)
    .set({ autoPullStartedAt: now })
    .where(
      and(
        eq(snowflakeConnection.id, 1),
        or(
          isNull(snowflakeConnection.autoPullStartedAt),
          lt(snowflakeConnection.autoPullStartedAt, new Date(now.getTime() - 15 * 60 * 1000)),
        ),
      ),
    )
    .returning({ id: snowflakeConnection.id })
  if (claimed.length === 0) {
    return NextResponse.json({ ran: false, reason: 'A pull is already running.' })
  }

  const ownerId = conn.autoPullUserId
  const [owner] = ownerId
    ? await db.select({ role: user.role }).from(user).where(eq(user.id, ownerId)).limit(1)
    : []
  if (!owner || !canAdmin(owner.role as Role)) {
    const message = 'The admin who scheduled this pull no longer has admin access. Re-save the schedule.'
    await finish(false, message, false)
    return NextResponse.json({ ran: false, reason: message })
  }

  try {
    const result = await runSnowflakePull(ownerId!)
    if (!result.ok) {
      await finish(false, result.message, false)
      return NextResponse.json({ ran: true, ok: false, message: result.message })
    }
    const rows = result.imports.reduce((n, i) => n + i.rowCount, 0)
    const message =
      `Staged ${result.imports.length} import${result.imports.length === 1 ? '' : 's'} ` +
      `(${rows.toLocaleString()} rows) for review` +
      (result.skipped.length ? `; no data for ${result.skipped.join(', ')}.` : '.')
    await finish(true, message, true)
    return NextResponse.json({ ran: true, ok: true, message })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scheduled pull failed.'
    console.error('[snowflake-cron] pull failed', err)
    await finish(false, message, false)
    return NextResponse.json({ ran: true, ok: false, message }, { status: 500 })
  }
}
