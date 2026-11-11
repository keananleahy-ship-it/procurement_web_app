// Canonical viscosity / consistency grade format. Every stored value is one of:
//
//   SAE 15W-40   multigrade (SAE J300 engine or SAE J306 gear)
//   SAE 10W      winter monograde
//   SAE 30       summer / straight monograde — never "30W"
//   ISO VG 46    ISO 3448 industrial grade
//   NLGI 2       grease consistency (NLGI scale, not a viscosity, but stored
//                in the same attribute so greases still compare)
//
// Engine (J300) and gear (J306) numbers are separate scales: an SAE 90 gear oil
// is roughly as thick as an SAE 40 engine oil. A grade is only accepted when the
// numbers are real grades within ONE scale, which is what catches truncated
// parses like "SAE 10W-1" and non-grades like "SAE 30/40W".

export const SAE_ENGINE_WINTER = [0, 5, 10, 15, 20, 25]
export const SAE_ENGINE_HOT = [8, 12, 16, 20, 30, 40, 50, 60]
export const SAE_GEAR_WINTER = [70, 75, 80, 85]
export const SAE_GEAR_HOT = [80, 85, 90, 110, 140, 190, 250]
export const ISO_VG_GRADES = [
  2, 3, 5, 7, 10, 15, 22, 32, 46, 68, 100, 150, 220, 320, 460, 680, 1000, 1500,
  2200, 3200,
]
export const NLGI_GRADES = ['000', '00', '0', '1', '2', '3', '4', '5', '6']

export type ViscosityScale = 'SAE engine' | 'SAE gear' | 'ISO VG' | 'NLGI'

export type ParsedViscosity = {
  value: string
  scale: ViscosityScale
}

function multigrade(winter: number, hot: number): ParsedViscosity | null {
  if (SAE_ENGINE_WINTER.includes(winter) && SAE_ENGINE_HOT.includes(hot)) {
    return { value: `SAE ${winter}W-${hot}`, scale: 'SAE engine' }
  }
  if (SAE_GEAR_WINTER.includes(winter) && SAE_GEAR_HOT.includes(hot)) {
    return { value: `SAE ${winter}W-${hot}`, scale: 'SAE gear' }
  }
  return null
}

function winterMono(n: number): ParsedViscosity | null {
  if (SAE_ENGINE_WINTER.includes(n)) {
    return { value: `SAE ${n}W`, scale: 'SAE engine' }
  }
  if (SAE_GEAR_WINTER.includes(n)) {
    return { value: `SAE ${n}W`, scale: 'SAE gear' }
  }
  return null
}

function summerMono(n: number): ParsedViscosity | null {
  if (SAE_ENGINE_HOT.includes(n)) return { value: `SAE ${n}`, scale: 'SAE engine' }
  if (SAE_GEAR_HOT.includes(n)) return { value: `SAE ${n}`, scale: 'SAE gear' }
  return null
}

// Parse a stored or typed grade (not a product name) into the canonical form.
// Returns null when the text is not a recognizable, valid grade.
export function parseViscosity(raw: string | null | undefined): ParsedViscosity | null {
  if (!raw) return null
  const s = raw.toUpperCase().replace(/\s+/g, ' ').trim()
  if (!s) return null

  const nlgi = s.match(/\bN[LG]{2}I\s*(?:GRADE\s*)?#?\s*(0{1,3}|[1-6])\b/)
  if (nlgi) return { value: `NLGI ${nlgi[1]}`, scale: 'NLGI' }

  const iso = s.match(/\b(?:ISO\s*(?:VG)?|VG)\s*-?\s*(\d{1,4})\b/)
  if (iso) {
    const n = Number(iso[1])
    return ISO_VG_GRADES.includes(n) ? { value: `ISO VG ${n}`, scale: 'ISO VG' } : null
  }

  const body = s.replace(/^SAE\s*/, '')
  const multi = body.match(
    /^(\d{1,3})(?:\s*W\s*[-/]?|\s*[-/])\s*(\d{1,3})\s*W?T?$/,
  )
  if (multi) {
    const w = Number(multi[1])
    const h = Number(multi[2])
    // "20/20" style with equal numbers is the 20W-20 multigrade.
    return multigrade(w, h)
  }

  const mono = body.match(/^(\d{1,3})\s*(W|WT)?$/)
  if (mono) {
    const n = Number(mono[1])
    const hasW = mono[2] === 'W'
    // "10W" is a real winter grade; "30W"/"90W"/"10WT" are informal ways of
    // writing the straight grade, so fall through to the summer scale.
    if (hasW) return winterMono(n) ?? summerMono(n)
    return summerMono(n) ?? (mono[2] ? winterMono(n) : null)
  }

  return null
}

export function normalizeViscosity(raw: string | null | undefined): string | null {
  return parseViscosity(raw)?.value ?? null
}

export const VISCOSITY_FORMAT_HINT =
  'Use SAE 15W-40, SAE 10W, SAE 30, ISO VG 46, or NLGI 2'

// For write paths: canonicalize a typed value, or reject it so non-grades
// ("NA", "2-Cycle", truncated "10W-1") never reach the catalog.
export function canonicalViscosityOrThrow(value: string | null): string | null {
  if (!value) return null
  const v = normalizeViscosity(value)
  if (!v) throw new Error(`"${value}" is not a recognized grade. ${VISCOSITY_FORMAT_HINT}.`)
  return v
}

// Pull a grade out of a free-text product name. Stricter than parseViscosity:
// a bare number in a name is usually a product code or pack size, so it only
// counts with a W suffix, an SAE/ISO/NLGI prefix, or a W/slash multigrade.
export function viscosityFromName(name: string): string | null {
  const upper = name.toUpperCase()
  // Coolant blend ratios (50/50) and pack counts (12/1, 3/2, 6/1QT) are not
  // grades; pack counts fail multigrade validation, ratios are removed here.
  const text = upper.replace(/\b50\s*\/\s*50\b/g, ' ')

  const nlgi = text.match(/\bN[LG]{2}I\s*#?\s*(0{1,3}|[1-6])\b/)
  if (nlgi) return `NLGI ${nlgi[1]}`

  // Multigrade written 15W-40, 15W40, 15W/40, 15/40, 80W/85W. The winter
  // number is anchored to real winter grades so a product code glued in front
  // ("T610W30" = T6 + 10W-30) still splits correctly, and the hot number is
  // validated against the matching scale.
  const notPack = String.raw`(?!\d)(?!\.\d)(?!\s*(?:QT|L\b|ML|GAL|OZ|KG|LB|#))`
  const withW = new RegExp(
    String.raw`(0|5|10|15|20|25|70|75|80|85)W(?:\s*[-/]\s*)?(\d{1,3})` + notPack,
    'g',
  )
  // Without a W, only engine shorthand ("15/40") counts. A bare "80/90" is too
  // ambiguous ("WHITE OIL 80/90" is not an 80W-90 gear oil).
  const slashOnly = new RegExp(
    String.raw`(?<![\d.])(0|5|10|15|20|25)\s*/\s*(\d{1,2})` + notPack,
    'g',
  )
  for (const re of [withW, slashOnly]) {
    for (const m of text.matchAll(re)) {
      const g = multigrade(Number(m[1]), Number(m[2]))
      if (g) return g.value
    }
  }

  const winter = text.match(/(?<!\d)(\d{1,3})\s*WT?(?![A-Z\d])(?!\s*[-/]\s*\d)/)
  if (winter) {
    const n = Number(winter[1])
    const g = winter[0].includes('WT')
      ? (summerMono(n) ?? winterMono(n))
      : (winterMono(n) ?? summerMono(n))
    if (g) return g.value
  }

  const saeMono = text.match(/\bSAE\s*(\d{1,3})\b(?!\s*[-/W])/)
  if (saeMono) {
    const g = summerMono(Number(saeMono[1]))
    if (g) return g.value
  }

  const hasIsoContext = /\b(ISO\s*VG|ISO|VG)\b/.test(text)
  const iso = text.match(/\b(?:ISO\s*VG|ISO|VG)\s*-?\s*(\d{1,4})\b/)
  if (iso && ISO_VG_GRADES.includes(Number(iso[1]))) return `ISO VG ${Number(iso[1])}`

  // Bare industrial grade ("MEGAFLOW AW 46"), skipping numbers followed by a
  // unit (205L, 20 KG). Tiny grades collide with NLGI numbers and product-code
  // suffixes, so they need explicit ISO/VG context.
  for (const m of text.matchAll(/(?<![\d/.])\b(\d{1,4})\b(?!\s*(?:L|ML|KG|USG|X|QT|GAL|OZ|LB|#|\/))/g)) {
    const n = Number(m[1])
    if (!ISO_VG_GRADES.includes(n)) continue
    if (n < 22 && !hasIsoContext) continue
    return `ISO VG ${n}`
  }
  return null
}
