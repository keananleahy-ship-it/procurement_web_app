// Pure scheduling rules for the automatic Snowflake pull. The cron fires once a
// day (see vercel.json); these decide whether today's tick should actually pull.

export const AUTO_PULL_FREQUENCIES = ['off', 'daily', 'weekly', 'monthly'] as const
export type AutoPullFrequency = (typeof AUTO_PULL_FREQUENCIES)[number]

export const CRON_HOUR_UTC = 11

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export type AutoPullSchedule = {
  frequency: AutoPullFrequency
  weekday: number
  monthDay: number
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export function normalizeFrequency(raw: string | null | undefined): AutoPullFrequency {
  return (AUTO_PULL_FREQUENCIES as readonly string[]).includes(raw ?? '')
    ? (raw as AutoPullFrequency)
    : 'off'
}

// A run is due on its scheduled day. If a scheduled run failed or was missed,
// the next daily tick past the period catches up instead of waiting a whole
// extra week or month. The 20h floor stops a retried cron from pulling twice.
export function isAutoPullDue(
  schedule: AutoPullSchedule,
  lastSuccessAt: Date | null,
  now: Date,
): boolean {
  if (schedule.frequency === 'off') return false
  const sinceLast = lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() : Infinity
  if (sinceLast < 20 * HOUR) return false
  switch (schedule.frequency) {
    case 'daily':
      return true
    case 'weekly':
      return (
        now.getUTCDay() === schedule.weekday ||
        (lastSuccessAt !== null && sinceLast > 7 * DAY + 12 * HOUR)
      )
    case 'monthly':
      return (
        now.getUTCDate() === schedule.monthDay ||
        (lastSuccessAt !== null && sinceLast > 31 * DAY + 12 * HOUR)
      )
  }
}

export function describeSchedule(s: AutoPullSchedule): string {
  switch (s.frequency) {
    case 'off':
      return 'Automatic pulls are off.'
    case 'daily':
      return 'Pulls every day.'
    case 'weekly':
      return `Pulls every ${WEEKDAYS[s.weekday] ?? 'Monday'}.`
    case 'monthly':
      return `Pulls on day ${s.monthDay} of each month.`
  }
}
