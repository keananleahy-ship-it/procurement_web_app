export function formatCurrency(value: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
  }
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

// Timestamps are shown in a fixed business timezone so the server (UTC) and
// the browser render the same calendar day; otherwise hydration mismatches.
const BUSINESS_TIME_ZONE = 'America/Chicago'

const calendarDateFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

const timestampDateFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: BUSINESS_TIME_ZONE,
})

// Accepts a Date / ISO timestamp, or a 'YYYY-MM-DD' string (Postgres date,
// shown as that exact calendar day).
export function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—'
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (m) {
      return calendarDateFmt.format(
        new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
      )
    }
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return timestampDateFmt.format(d)
}
