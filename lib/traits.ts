// Trait-based product comparison. A product is described by a small set of
// parsable characteristics; the user dials how tightly each one must agree for
// two products to be considered comparable. Shared by client and server.

import { packFamily, PACK_FAMILIES } from './pack-family'

export type TraitKey =
  | 'category'
  | 'viscosity'
  | 'formulation'
  | 'spec'
  | 'pack'
  | 'brand'

export type TraitLevel = 'exact' | 'close' | 'ignore'

export type Tightness = Record<TraitKey, TraitLevel> & {
  // How a missing trait behaves when the trait is required (exact/close).
  // 'no-match' keeps the product out of any group; 'wildcard' groups it with
  // other products that are also missing the trait.
  missing: 'no-match' | 'wildcard'
}

export type ProductTraits = {
  category: string | null
  viscosity: string | null
  formulation: string | null
  spec: string | null
  brand: string | null
  packSize: number | null
  baseUnit: string | null
}

export type TraitDef = {
  key: TraitKey
  label: string
  // Levels this trait supports (category/brand have no meaningful "close").
  levels: TraitLevel[]
  closeHint: string
}

export const TRAITS: TraitDef[] = [
  {
    key: 'category',
    label: 'Category',
    levels: ['exact', 'ignore'],
    closeHint: '',
  },
  {
    key: 'viscosity',
    label: 'Viscosity',
    levels: ['exact', 'close', 'ignore'],
    closeHint: 'Same hot grade (xW-40) or adjacent ISO VG band',
  },
  {
    key: 'formulation',
    label: 'Formulation',
    levels: ['exact', 'close', 'ignore'],
    closeHint: 'Synthetic + blend together; conventional apart',
  },
  {
    key: 'spec',
    label: 'Performance spec',
    levels: ['exact', 'close', 'ignore'],
    closeHint: 'Same spec family (CK-4 covers CJ-4, CI-4)',
  },
  {
    key: 'pack',
    label: 'Pack type',
    levels: ['exact', 'close', 'ignore'],
    closeHint: 'Same container family (bulk, drum, pail, case)',
  },
  {
    key: 'brand',
    label: 'Brand',
    levels: ['exact', 'ignore'],
    closeHint: '',
  },
]

export const PRESETS: Record<'identical' | 'like' | 'similar', Tightness> = {
  identical: {
    category: 'exact',
    viscosity: 'exact',
    formulation: 'exact',
    spec: 'exact',
    pack: 'exact',
    brand: 'exact',
    missing: 'no-match',
  },
  like: {
    category: 'exact',
    viscosity: 'exact',
    formulation: 'exact',
    spec: 'exact',
    pack: 'ignore',
    brand: 'ignore',
    missing: 'no-match',
  },
  similar: {
    category: 'exact',
    viscosity: 'close',
    formulation: 'close',
    spec: 'ignore',
    pack: 'ignore',
    brand: 'ignore',
    missing: 'no-match',
  },
}

export type PresetId = keyof typeof PRESETS
export const PRESET_LABELS: Record<PresetId, string> = {
  identical: 'Identical',
  like: 'Like',
  similar: 'Similar',
}
export const DEFAULT_TIGHTNESS: Tightness = PRESETS.like

export function presetFor(t: Tightness): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = PRESETS[id]
    if (
      TRAITS.every((d) => p[d.key] === t[d.key]) &&
      p.missing === t.missing
    ) {
      return id
    }
  }
  return null
}

// --- URL encoding -----------------------------------------------------------
// Compact form for search params: one letter per trait in TRAITS order
// (e/c/i) plus the missing policy (n/w), e.g. "eeeeii-n".

const LEVEL_CODE: Record<TraitLevel, string> = {
  exact: 'e',
  close: 'c',
  ignore: 'i',
}

export function encodeTightness(t: Tightness): string {
  const preset = presetFor(t)
  if (preset) return preset
  return (
    TRAITS.map((d) => LEVEL_CODE[t[d.key]]).join('') +
    '-' +
    (t.missing === 'wildcard' ? 'w' : 'n')
  )
}

export function decodeTightness(raw: string | null | undefined): Tightness {
  if (!raw) return DEFAULT_TIGHTNESS
  if (raw in PRESETS) return PRESETS[raw as PresetId]
  const [levels, missing] = raw.split('-')
  if (!levels || levels.length !== TRAITS.length) return DEFAULT_TIGHTNESS
  const out = { ...DEFAULT_TIGHTNESS }
  TRAITS.forEach((d, i) => {
    const code = levels[i]
    const level: TraitLevel =
      code === 'e' ? 'exact' : code === 'c' ? 'close' : 'ignore'
    out[d.key] = d.levels.includes(level) ? level : 'exact'
  })
  out.missing = missing === 'w' ? 'wildcard' : 'no-match'
  return out
}

// --- Performance spec parser ----------------------------------------------

type SpecRule = { family: string; value: string; test: RegExp }

// Ordered within each family from highest to lowest, so the first hit in a
// family is the top spec the product claims.
const SPEC_RULES: SpecRule[] = [
  // API heavy-duty diesel (backward-compatible C ladder)
  { family: 'API C', value: 'CK-4', test: /\bCK-?4\b/ },
  { family: 'API C', value: 'CJ-4', test: /\bCJ-?4\b/ },
  { family: 'API C', value: 'CI-4', test: /\bCI-?4\b/ },
  { family: 'API C', value: 'CH-4', test: /\bCH-?4\b/ },
  { family: 'API C', value: 'CF', test: /\bCF(-?4)?\b/ },
  // FA-4 is not backward compatible, so it is its own family.
  { family: 'API FA', value: 'FA-4', test: /\bFA-?4\b/ },
  // API gasoline / ILSAC
  { family: 'API S', value: 'SP', test: /\bSP\b/ },
  { family: 'API S', value: 'SN', test: /\bSN\b/ },
  { family: 'API S', value: 'SM', test: /\bSM\b/ },
  { family: 'ILSAC', value: 'GF-6', test: /\bGF-?6[AB]?\b/ },
  { family: 'ILSAC', value: 'GF-5', test: /\bGF-?5\b/ },
  { family: 'dexos', value: 'dexos', test: /\bDEXOS\s*\d?/ },
  // Gear
  { family: 'API GL', value: 'GL-5', test: /\bGL-?5\b/ },
  { family: 'API GL', value: 'GL-4', test: /\bGL-?4\b/ },
  // Drivetrain / OEM
  { family: 'TO-4', value: 'TO-4', test: /\bTO-?4\b/ },
  { family: 'J20', value: 'J20C', test: /\bJ-?20[A-D]?\b/ },
  { family: 'ECF', value: 'ECF-3', test: /\bECF-?\d\b/ },
  { family: 'ATF', value: 'DEXRON VI', test: /DEXRON\s*-?\s*(VI|6)\b/ },
  { family: 'ATF', value: 'MERCON', test: /\bMERCON\b/ },
  { family: 'ATF', value: 'Allison', test: /\bALLISON\b|\bTES[\s-]*(295|668|389)\b/ },
  // Industrial
  { family: 'Food grade', value: 'NSF H1', test: /\bH1\b|\bNSF\b|FOOD\s*GRADE|\bFG\b|PURITY/ },
  { family: 'Industrial', value: 'Zinc-free AW', test: /ZINC[\s-]*FREE|ASHLESS|\bNZ\b/ },
  { family: 'Industrial', value: 'AW', test: /\bAW\b|ANTI-?\s*WEAR/ },
  { family: 'Industrial', value: 'R&O', test: /R\s*&\s*O\b|\bR\s+O\b|RUST.*OXID/ },
]

// Returns a normalized spec set like "CK-4 / SN", or null when the name
// states no recognizable spec.
export function deriveSpec(name: string): string | null {
  const upper = name.toUpperCase()
  const seen = new Set<string>()
  const values: string[] = []
  for (const r of SPEC_RULES) {
    if (seen.has(r.family)) continue
    if (r.test.test(upper)) {
      seen.add(r.family)
      values.push(r.value)
    }
  }
  return values.length ? values.join(' / ') : null
}

const FAMILY_OF = new Map(SPEC_RULES.map((r) => [r.value, r.family]))

function specFamilies(spec: string): string {
  return spec
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => FAMILY_OF.get(v) ?? v)
    .sort()
    .join(' + ')
}

// --- Close buckets ----------------------------------------------------------

const ISO_BANDS: [number, number, string][] = [
  [0, 15, 'ISO VG ≤15'],
  [16, 32, 'ISO VG 22–32'],
  [33, 68, 'ISO VG 46–68'],
  [69, 150, 'ISO VG 100–150'],
  [151, 320, 'ISO VG 220–320'],
  [321, 100000, 'ISO VG 460+'],
]

function viscosityClose(v: string): string {
  const multi = v.match(/(\d+)W-(\d+)/)
  if (multi) return `SAE *-${multi[2]}`
  const mono = v.match(/SAE (\d+)W$/)
  if (mono && Number(mono[1]) >= 30) return `SAE *-${mono[1]}`
  const iso = v.match(/ISO VG (\d+)/)
  if (iso) {
    const n = Number(iso[1])
    const band = ISO_BANDS.find(([lo, hi]) => n >= lo && n <= hi)
    if (band) return band[2]
  }
  return v
}

function formulationClose(f: string): string {
  switch (f) {
    case 'Full Synthetic':
    case 'Synthetic Blend':
      return 'Synthetic / blend'
    case 'Zinc-Free':
    case 'Zinc-Free HVI':
      return 'Zinc-free'
    case 'AW':
    case 'MV/HVI':
      return 'AW / HVI'
    default:
      return f
  }
}

function packExact(t: ProductTraits): string | null {
  if (t.packSize == null) return null
  const size = Math.round(t.packSize * 100) / 100
  return `${size} ${t.baseUnit ?? ''}`.trim()
}

function packClose(t: ProductTraits): string | null {
  if (t.packSize == null) return null
  const id = packFamily(t.packSize, t.baseUnit)
  return PACK_FAMILIES.find((f) => f.id === id)?.label ?? id
}

// Value of a trait at a given level, or null when the trait is missing.
export function traitValue(
  traits: ProductTraits,
  key: TraitKey,
  level: Exclude<TraitLevel, 'ignore'>,
): string | null {
  switch (key) {
    case 'category':
      return traits.category
    case 'brand':
      return traits.brand
    case 'viscosity':
      if (!traits.viscosity) return null
      return level === 'close'
        ? viscosityClose(traits.viscosity)
        : traits.viscosity
    case 'formulation':
      if (!traits.formulation) return null
      return level === 'close'
        ? formulationClose(traits.formulation)
        : traits.formulation
    case 'spec':
      // An unstated spec is itself a value ("Not stated"), so most products
      // without one still compare with each other instead of dropping out.
      if (!traits.spec) return 'Not stated'
      return level === 'close' ? specFamilies(traits.spec) : traits.spec
    case 'pack':
      return level === 'close' ? packClose(traits) : packExact(traits)
  }
}

// The group key for a product under the chosen tightness, or null when a
// required trait is missing and the missing policy is 'no-match'.
export function comparisonKey(
  traits: ProductTraits,
  tightness: Tightness,
): string | null {
  const parts: string[] = []
  for (const d of TRAITS) {
    const level = tightness[d.key]
    if (level === 'ignore') continue
    const v = traitValue(traits, d.key, level)
    if (v == null || v === '') {
      if (tightness.missing === 'no-match') return null
      parts.push(`${d.key}=?`)
    } else {
      parts.push(`${d.key}=${v}`)
    }
  }
  return parts.join('|') || 'all'
}

// The traits that are required but missing for a product, for "Needs
// characteristics" reporting.
export function missingTraits(
  traits: ProductTraits,
  tightness: Tightness,
): TraitKey[] {
  return TRAITS.filter((d) => {
    const level = tightness[d.key]
    if (level === 'ignore') return false
    const v = traitValue(traits, d.key, level)
    return v == null || v === ''
  }).map((d) => d.key)
}

// Human label for a group key, e.g. "Engine Oil · SAE 15W-40 · CK-4".
export function groupLabel(key: string): string {
  if (key === 'all') return 'All products'
  return key
    .split('|')
    .map((p) => p.split('=')[1])
    .filter((v) => v && v !== '?' && v !== 'Not stated')
    .join(' · ')
}
