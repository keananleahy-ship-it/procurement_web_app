// Pure helpers for reading purchase lines out of a mapped Snowflake view.
// Kept free of server-only imports so the SQL they build can be unit-checked.

export const SOURCE_FIELDS = [
  { key: 'site', label: 'Warehouse / site', required: true },
  { key: 'businessUnit', label: 'Business unit (rollup)', required: false },
  { key: 'region', label: 'Region (rollup)', required: false },
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

// --- Location rollup ---------------------------------------------------------
// Warehouses roll up to platform locations through four levels:
// region -> platform group -> business unit -> warehouse. Regions and business
// units come from the view; platform groups are defined in the app and collect
// business units. The most specific rule wins, so a whole group can be
// assigned once and single business units or warehouses overridden.

export const EXCLUDE = 'exclude' as const
export type RollupTarget = number | typeof EXCLUDE
export type RollupLevel = 'region' | 'group' | 'businessUnit' | 'site'
export type RuleMap = Record<string, RollupTarget>
export type SiteRollup = Record<RollupLevel, RuleMap> & {
  // Platform group name -> business unit names it collects.
  groups: Record<string, string[]>
}

export const ROLLUP_LEVELS: { key: RollupLevel; label: string }[] = [
  { key: 'site', label: 'Warehouse' },
  { key: 'businessUnit', label: 'Business unit' },
  { key: 'group', label: 'Platform group' },
  { key: 'region', label: 'Region' },
]

export function emptyRollup(): SiteRollup {
  return { region: {}, group: {}, businessUnit: {}, site: {}, groups: {} }
}

export function normalizeRollup(raw: Partial<SiteRollup> | null | undefined): SiteRollup {
  const base = emptyRollup()
  if (!raw) return base
  return {
    region: { ...(raw.region ?? {}) },
    group: { ...(raw.group ?? {}) },
    businessUnit: { ...(raw.businessUnit ?? {}) },
    site: { ...(raw.site ?? {}) },
    groups: { ...(raw.groups ?? {}) },
  }
}

// Case, spacing and punctuation are ignored, so "AEG-AMARILLO",
// "AEG-Amarillo" and "AEG - amarillo" are one warehouse.
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Warehouses are only merged inside one business unit: the same town name can
// be a different operation in another unit (e.g. AEG-Hugoton in AEG and in
// Brown Dupree).
export function siteRuleKey(businessUnit: string | null, site: string): string {
  return `${normalizeName(businessUnit)}::${normalizeName(site)}`
}

export function groupOf(rollup: SiteRollup, businessUnit: string | null): string | null {
  if (!businessUnit) return null
  const unit = normalizeName(businessUnit)
  for (const [name, units] of Object.entries(rollup.groups)) {
    if (units.some((u) => normalizeName(u) === unit)) return name
  }
  return null
}

export type SiteKey = { region: string | null; businessUnit: string | null; site: string }

export type Resolution = { target: RollupTarget | null; level: RollupLevel | null }

// `from` skips the more specific levels, which is how a row shows what it
// would inherit from its parent.
export function resolveSite(
  key: SiteKey,
  rollup: SiteRollup,
  from: RollupLevel = 'site',
): Resolution {
  const start = ROLLUP_LEVELS.findIndex((l) => l.key === from)
  for (const { key: level } of ROLLUP_LEVELS.slice(start)) {
    const ruleKey =
      level === 'site'
        ? siteRuleKey(key.businessUnit, key.site)
        : level === 'group'
          ? groupOf(rollup, key.businessUnit)
          : key[level]
    if (ruleKey === null) continue
    const target = rollup[level]?.[ruleKey]
    if (target !== undefined) return { target, level }
  }
  return { target: null, level: null }
}

// Every location id any rule points at.
export function rollupLocationIds(rollup: SiteRollup): number[] {
  const ids = new Set<number>()
  for (const { key } of ROLLUP_LEVELS) {
    for (const t of Object.values(rollup[key] ?? {})) if (typeof t === 'number') ids.add(t)
  }
  return [...ids]
}

export type HierarchyEntry = {
  region: string | null
  businessUnit: string | null
  site: string
  variants: string[]
  lines: number
  qty: number
  lastDate: string | null
}

// Folds spelling and punctuation variants of one warehouse into a single
// entry, labelled with the variant that carries the most lines.
export function mergeSiteVariants(
  rows: Omit<HierarchyEntry, 'variants'>[],
): HierarchyEntry[] {
  const merged = new Map<string, HierarchyEntry & { topLines: number }>()
  for (const r of rows) {
    const key = `${normalizeName(r.region)}|${siteRuleKey(r.businessUnit, r.site)}`
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...r, variants: [r.site], topLines: r.lines })
      continue
    }
    prev.variants.push(r.site)
    if (r.lines > prev.topLines) {
      prev.site = r.site
      prev.topLines = r.lines
    }
    prev.lines += r.lines
    prev.qty += r.qty
    if (r.lastDate && (!prev.lastDate || r.lastDate > prev.lastDate)) prev.lastDate = r.lastDate
  }
  return [...merged.values()].map(({ topLines: _, ...e }) => ({
    ...e,
    variants: [...e.variants].sort((a, z) => (a === e.site ? -1 : z === e.site ? 1 : 0)),
  }))
}

const col = (map: ColumnMap, k: SourceFieldKey) => (map[k] ? quoteColumn(map[k]!) : null)
const text = (c: string | null) => (c ? `to_varchar(${c})` : 'null')

// One row per region + business unit + warehouse with its volume in the
// window, so the rollup screen can show what each assignment carries.
export function buildHierarchyQuery(opts: { table: string; map: ColumnMap }): string {
  const { table, map } = opts
  const qty = col(map, 'quantity')!
  const date = col(map, 'date')!
  return `select ${text(col(map, 'region'))} as "region",
       ${text(col(map, 'businessUnit'))} as "businessUnit",
       ${text(col(map, 'site'))} as "site",
       count_if(${date} >= dateadd(month, -?, current_date())) as "lines",
       sum(iff(${date} >= dateadd(month, -?, current_date()), ${qty}, 0)) as "qty",
       max(${date}) as "lastDate"
from ${table}
group by 1, 2, 3
order by 1, 2, 3
limit 5000`
}

export type HierarchyRow = {
  region: string | null
  businessUnit: string | null
  site: string | null
  lines: number | string
  qty: number | string | null
  lastDate: Date | string | null
}

// One aggregated row per warehouse + item + code + unit over the lookback
// window. Rollup to locations happens in the app so rules stay editable.
// Spend is weighted only over lines that carry a cost, so blank costs don't
// pull the average toward zero.
export function buildPullQuery(opts: { table: string; map: ColumnMap }): string {
  const { table, map } = opts
  const qty = col(map, 'quantity')!
  const date = col(map, 'date')!
  const unitCost = col(map, 'unitCost')
  const spend = unitCost ? `${qty} * ${unitCost}` : col(map, 'extendedCost')
  const costed = unitCost ?? col(map, 'extendedCost')

  return `select ${text(col(map, 'region'))} as "region",
       ${text(col(map, 'businessUnit'))} as "businessUnit",
       ${text(col(map, 'site'))} as "site",
       ${text(col(map, 'itemName'))} as "item",
       ${text(col(map, 'sku'))} as "sku",
       ${text(col(map, 'unit'))} as "unit",
       sum(${qty}) as "qty",
       ${spend ? `sum(${spend})` : 'null'} as "spend",
       ${costed ? `sum(case when ${costed} is not null then ${qty} end)` : 'null'} as "costedQty",
       count(*) as "lines",
       min(${date}) as "firstDate",
       max(${date}) as "lastDate"
from ${table}
where ${date} >= dateadd(month, -?, current_date())
  and ${qty} is not null
group by 1, 2, 3, 4, 5, 6`
}

// Several warehouses roll into one location, so the same item can arrive in
// several rows; combine them before staging so each item appears once.
export function mergePulledRows(rows: PulledRow[]): PulledRow[] {
  const merged = new Map<string, PulledRow>()
  const add = (a: PulledRow['qty'], b: PulledRow['qty']) =>
    a === null && b === null ? null : Number(a ?? 0) + Number(b ?? 0)
  const earliest = (a: PulledRow['firstDate'], b: PulledRow['firstDate']) =>
    !a ? b : !b ? a : new Date(a) <= new Date(b) ? a : b
  const latest = (a: PulledRow['lastDate'], b: PulledRow['lastDate']) =>
    !a ? b : !b ? a : new Date(a) >= new Date(b) ? a : b
  for (const row of rows) {
    const key = JSON.stringify([
      (row.item ?? '').trim().toLowerCase(),
      (row.sku ?? '').trim().toLowerCase(),
      (row.unit ?? '').trim().toLowerCase(),
    ])
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...row })
      continue
    }
    prev.qty = add(prev.qty, row.qty)
    prev.spend = add(prev.spend, row.spend)
    prev.costedQty = add(prev.costedQty, row.costedQty)
    prev.lines = Number(prev.lines) + Number(row.lines)
    prev.firstDate = earliest(prev.firstDate, row.firstDate)
    prev.lastDate = latest(prev.lastDate, row.lastDate)
  }
  return [...merged.values()]
}

export type PulledRow = {
  region: string | null
  businessUnit: string | null
  site: string | null
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
