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

// Accepts a Date or a 'YYYY-MM-DD' string (Postgres date) and formats it
// without timezone drift.
export function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—'
  let d: Date
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
    d = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      : new Date(value)
  } else {
    d = value
  }
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
