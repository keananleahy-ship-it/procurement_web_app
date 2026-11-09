// Pure helpers for reading purchase lines out of a mapped Snowflake view.
// Kept free of server-only imports so the SQL they build can be unit-checked.

export const SOURCE_FIELDS = [
  { key: 'site', label: 'Site / location', required: true },
  { key: 'date', label: 'Purchase date', required: true },
  { key: 'itemName', label: 'Item name', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'sku', label: 'Item code / SKU', required: false },
  { key: 'unit', label: 'Unit of measure', required: false },
  { key: 'unitCost', label: 'Unit cost', required: false },
  { key: 'extendedCost', label: 'Line total cost', required: false },
] as const

export type SourceFieldKey = (typeof SOURCE_FIELDS)[number]['key']
export type ColumnMap = Partial<Record<SourceFieldKey, string>>

const UNQUOTED_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/
const QUOTED_PART = /^"[^"]+"$/

// Turns DB.SCHEMA.VIEW (any part optionally "quoted") into a safe identifier.
// Rejects anything else, so the table name can never carry SQL.
export function parseTableName(input: string): string {
  const raw = input.trim()
  const parts = raw.match(/"[^"]*"|[^.]+/g) ?? []
  if (
    parts.length === 0 ||
    parts.length > 3 ||
    parts.join('.') !== raw ||
    !parts.every((p) => UNQUOTED_PART.test(p) || QUOTED_PART.test(p))
  ) {
    throw new Error(
      'Enter the view as DATABASE.SCHEMA.VIEW (quote any part that has spaces or lowercase letters).',
    )
  }
  return parts.join('.')
}

// Column names come from Snowflake's own metadata and are always quoted, so
// they match exactly and cannot break out of the identifier.
export function quoteColumn(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function validateColumnMap(map: ColumnMap, liveColumns: string[]): string | null {
  const live = new Set(liveColumns)
  for (const f of SOURCE_FIELDS) {
    const col = map[f.key]
    if (f.required && !col) return `Choose a column for ${f.label}.`
    if (col && !live.has(col)) {
      return `Column ${col} is no longer in the view. Reload columns and remap.`
    }
  }
  return null
}

// One aggregated row per site + item + code + unit over the lookback window.
// Spend is weighted only over lines that carry a cost, so blank costs don't
// pull the average toward zero.
export function buildPullQuery(opts: {
  table: string
  map: ColumnMap
  siteCount: number
}): string {
  const { table, map, siteCount } = opts
  const col = (k: SourceFieldKey) => (map[k] ? quoteColumn(map[k]!) : null)
  const site = col('site')!
  const qty = col('quantity')!
  const date = col('date')!
  const text = (c: string | null) => (c ? `to_varchar(${c})` : 'null')
  const spend = col('unitCost')
    ? `${qty} * ${col('unitCost')}`
    : col('extendedCost')
  const costed = col('unitCost') ?? col('extendedCost')

  const placeholders = Array.from({ length: siteCount }, () => '?').join(', ')
  return `select ${text(site)} as "site",
       ${text(col('itemName'))} as "item",
       ${text(col('sku'))} as "sku",
       ${text(col('unit'))} as "unit",
       sum(${qty}) as "qty",
       ${spend ? `sum(${spend})` : 'null'} as "spend",
       ${costed ? `sum(case when ${costed} is not null then ${qty} end)` : 'null'} as "costedQty",
       count(*) as "lines",
       min(${date}) as "firstDate",
       max(${date}) as "lastDate"
from ${table}
where ${text(site)} in (${placeholders})
  and ${date} >= dateadd(month, -?, current_date())
  and ${qty} is not null
group by 1, 2, 3, 4`
}

export type PulledRow = {
  site: string
  item: string | null
  sku: string | null
  unit: string | null
  qty: number | string | null
  spend: number | string | null
  costedQty: number | string | null
  lines: number | string
  firstDate: Date | string | null
  lastDate: Date | string | null
}

export type StagedVolume = {
  itemName: string
  sku: string | null
  baseUnit: string | null
  annualVolume: string
  baselineUnitCost: string | null
}

// Annualizes the window total and derives the volume-weighted unit cost.
export function toStagedVolume(row: PulledRow, lookbackMonths: number): StagedVolume | null {
  const qty = Number(row.qty)
  const itemName = (row.item ?? '').trim()
  if (!itemName || !Number.isFinite(qty) || qty <= 0) return null
  const spend = row.spend === null ? NaN : Number(row.spend)
  const costedQty = row.costedQty === null ? NaN : Number(row.costedQty)
  const unitCost =
    Number.isFinite(spend) && Number.isFinite(costedQty) && costedQty > 0
      ? spend / costedQty
      : null
  return {
    itemName,
    sku: row.sku?.trim() || null,
    baseUnit: row.unit?.trim() || null,
    annualVolume: ((qty * 12) / lookbackMonths).toFixed(2),
    baselineUnitCost: unitCost !== null ? unitCost.toFixed(4) : null,
  }
}

export function periodLabel(lookbackMonths: number): string {
  return lookbackMonths === 12 ? 'TTM' : `Last ${lookbackMonths} mo (annualized)`
}
