// Shared definitions and derivation logic for the item hierarchy attributes.
//
// The compare/products/canonical screens organize items into a roll-up /
// expand hierarchy by nesting them under an ordered, user-chosen subset of
// these attributes (a pivot-style grouping). Values are first *derived* from
// the item name + pack size by scripts/derive-attributes.mjs, then may be
// corrected by reviewers in the UI.
//
// This file is intentionally free of server-only imports so it can be shared
// by the batch script (Node) and client components alike.

export type AttributeKey =
  | 'supplier'
  | 'category'
  | 'subcategory'
  | 'viscosity'
  | 'packageType'

export type AttributeDef = {
  key: AttributeKey
  label: string
}

// Full ordered set. The default Products hierarchy uses all five; Compare and
// Canonical use a subset (see each screen).
export const ALL_ATTRIBUTES: AttributeDef[] = [
  { key: 'supplier', label: 'Supplier' },
  { key: 'category', label: 'Category' },
  { key: 'subcategory', label: 'Subcategory' },
  { key: 'viscosity', label: 'Viscosity' },
  { key: 'packageType', label: 'Package size' },
]

// Attributes available on the Products screen (each product has one supplier
// and one pack size, so all five apply).
export const PRODUCT_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES

// Compare compares suppliers/pack sizes side-by-side *inside* each card, so
// those two are excluded as grouping levels there.
export const COMPARE_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES.filter(
  (a) => a.key !== 'supplier' && a.key !== 'packageType',
)

// A canonical item spans vendors and pack sizes, so it only carries the
// item-intrinsic attributes.
export const CANONICAL_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES.filter(
  (a) => a.key === 'category' || a.key === 'subcategory' || a.key === 'viscosity',
)

// Label shown for items missing a value for the grouping attribute.
export function emptyLabelFor(key: AttributeKey): string {
  switch (key) {
    case 'supplier':
      return 'No supplier'
    case 'category':
      return 'Uncategorized'
    case 'subcategory':
      return 'No subcategory'
    case 'viscosity':
      return 'No viscosity'
    case 'packageType':
      return 'No package size'
  }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

// Known ISO VG viscosity grades (the standard ISO 3448 ladder). Used to tell a
// real viscosity grade apart from an incidental number (pack size, product
// code, coolant ratio, etc.).
const ISO_VG_GRADES = [
  2, 3, 5, 7, 10, 15, 22, 32, 46, 68, 100, 150, 220, 320, 460, 680, 1000, 1500,
]

// Package descriptors, checked in priority order (most specific first). The
// label is the normalized bucket; the test matches against the UPPERCASED name.
const PACKAGE_PATTERNS: { label: string; test: RegExp }[] = [
  { label: 'Decant', test: /\bDECANT\b/ },
  { label: 'Bulk', test: /\bBULK\b/ },
  { label: 'IBC (1040L)', test: /\bIBC\b|\bTOTE\b/ },
  { label: 'Drum (205L)', test: /\bDRUMS?\b|\bDRM\b/ },
  { label: 'Pail (20L)', test: /\bPAILS?\b/ },
  { label: 'Keg', test: /\bKEG\b/ },
  { label: 'PetroPak', test: /PETRO\s*-?\s*PAK|PETROPAK/ },
  { label: 'Case', test: /\bCASE\b|\d+\s*X\s*\d+|\bCS\b/ },
  { label: 'Jug', test: /\bJUGS?\b/ },
  { label: 'Cartridge', test: /\bCART(RIDGE)?\b|\bTUBE\b/ },
]

// Category keyword map, checked in order (FIRST MATCH WINS). Order is
// deliberate: specific brand names and multi-word terms come before generic
// keywords so, e.g., a "CALFLO AF" heat-transfer fluid isn't grabbed by the
// loose antifreeze "AF" token. These are heuristics — reviewers correct the
// misses in the UI.
const CATEGORY_PATTERNS: { label: string; test: RegExp }[] = [
  {
    label: 'Food Grade Lubricant',
    test: /FOOD\s*(GRADE|MACHINERY)|PURITY\s*FG|\bFG\s|WHITE\s*OIL/,
  },
  {
    label: 'Heat Transfer Fluid',
    test: /HEAT\s*TRANSFER|\bHTF\b|CALFLO|PARAFLEX|THERMAL|PARATHERM/,
  },
  {
    label: 'Way & Slideway Oil',
    test: /SLIDEWAY|MULTI-?\s*WAY|\bWAY\s*OIL|\bTCS\b/,
  },
  {
    label: 'Grease',
    test: /GREASE|\bNLGI\b|#\s*\d{1,2}\b|MULTIPLEX|DYNALIFE|OMNIGUARD|DUOLEC|\bMOLY\b|LITHIUM|POLYUREA/,
  },
  {
    label: 'Compressor Fluid',
    test: /COMPRESSOR|COMPRO|PAG\s*COMP|\bCOMP\b|SYNDURO|\bPZA\b|AIR\s*COMP/,
  },
  {
    label: 'Transmission Fluid',
    test: /\bATF\b|ATF\s*\+?\s*4|ATF\s*D|TRANSMISSION|TRANSOIL|POWERTRAN|POWERDRIVE|DURATRAN|\bTRANS\b|\bMV\b|DEXRON|MERCON/,
  },
  {
    label: 'Antifreeze & Coolant',
    test: /ANT[I]?\s*-?FRE?E?ZE|ANTFRZ|COOLANT|\bAF\b|AF\/CL|\d{2}\/\d{2}/,
  },
  { label: 'Turbine Oil', test: /TURBINE|\bTURBO\b|TURBOFLO|SUNVIS/ },
  {
    label: 'Circulating / R&O Oil',
    test: /R\s*&\s*O|\bR\s+O\b|RUST.*OXID|CIRCULAT/,
  },
  {
    label: 'Hydraulic Fluid',
    test: /HYDRAULIC|HYDREX|\bHVI\b|\bAW\s*\d|\bHYD\b|POWERFLOW|TELLUS|HYDRO/,
  },
  {
    label: 'Gear Oil',
    test: /\bGEAR\b|\bEP\s*\d|\b80W|\b85W|\b75W|\bGL-?\d|OMALA|MORLINA/,
  },
  { label: 'Rock Drill Oil', test: /ROCK\s*DRILL/ },
  {
    label: 'Engine Oil',
    test: /ENGINE|MOTOR\s*OIL|\bDURON\b|\b\d{1,2}W-?\d{2}\b|\bSAE\b|DIESEL|\bCF\b|\bCK-?4\b/,
  },
  { label: 'Metalworking Fluid', test: /METALWORK|CUTTING|SOLUBLE/ },
  { label: 'Solvent & Cleaner', test: /SOLVENT|CLEAN(ING|ER)?|FLUSH(ING)?|DEGREAS/ },
  { label: 'Chain & Bar Oil', test: /\bCHAIN\b|\bBAR\b\s*OIL|CHAINSAW/ },
]

// Tokens stripped from a name to derive the product "line" (subcategory). These
// are package words, size tokens, and noise so that e.g.
// "ACCUFLO TK 68 205L DRUM" -> "Accuflo Tk".
const SUBCATEGORY_STRIP = [
  /\bBULK\b/g,
  /\bDECANT\b/g,
  /\bIBC\b/g,
  /\bTOTE\b/g,
  /\bDRUMS?\b/g,
  /\bDRM\b/g,
  /\bPAILS?\b/g,
  /\bKEG\b/g,
  /\bCASE\b/g,
  /\bCS\b/g,
  /\bJUGS?\b/g,
  /PETRO\s*-?\s*PAK|PETROPAK/g,
  /\bPETROPAK\b/g,
  /\bUS\s*GAL(LON)?\b/g,
  /\bUSG\b/g,
  /\d+\s*X\s*\d+\s*L?/g, // 12X1L, 4X1
  /\d+(\.\d+)?\s*L\b/g, // 205 L, 20L, 1040L
  /\d+(\.\d+)?\s*ML\b/g,
  /\d+(\.\d+)?\s*KG\b/g,
  /\d+(\.\d+)?\s*USG\b/g,
  /\(T\)/g,
  /\bDRUM\b/g,
]

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function derivePackageType(name: string, packSize?: number): string | null {
  const upper = name.toUpperCase()
  for (const p of PACKAGE_PATTERNS) {
    if (p.test.test(upper)) return p.label
  }
  // Fall back to pack-size buckets when the name has no descriptor.
  if (packSize != null) {
    if (packSize <= 1.01) return 'Bulk'
    if (packSize < 8) return 'Case'
    if (packSize < 10) return 'Pail (20L)'
    if (packSize < 100) return 'Drum (205L)'
    return 'IBC (1040L)'
  }
  return null
}

export function deriveCategory(name: string): string | null {
  const upper = name.toUpperCase()
  for (const c of CATEGORY_PATTERNS) {
    if (c.test.test(upper)) return c.label
  }
  return null
}

export function deriveViscosity(name: string): string | null {
  const upper = name.toUpperCase()
  // Coolant blend ratios like 50/50 are not a viscosity grade.
  const withoutRatios = upper.replace(/\d{2}\/\d{2}/g, ' ')
  // SAE multigrade, e.g. 15W-40, 5W30, 80W-90.
  const sae = withoutRatios.match(/\b(\d{1,2}W\s*-?\s*\d{2,3})\b/)
  if (sae) return 'SAE ' + sae[1].replace(/\s/g, '')
  // A single "W" grade, e.g. 0W, 5W.
  const saeSingle = withoutRatios.match(/\b(\d{1,2}W)\b/)
  if (saeSingle) return 'SAE ' + saeSingle[1]
  // ISO VG: find any standalone number that is a known grade, skipping numbers
  // immediately followed by a unit (205L, 20 KG) which are pack sizes.
  const numbers = withoutRatios.matchAll(/\b(\d{1,4})\b(?!\s*(L|ML|KG|USG|X))/g)
  for (const m of numbers) {
    const n = Number(m[1])
    if (ISO_VG_GRADES.includes(n)) return 'ISO VG ' + n
  }
  return null
}

export function deriveSubcategory(name: string): string | null {
  let s = name.toUpperCase()
  for (const re of SUBCATEGORY_STRIP) s = s.replace(re, ' ')
  // Drop standalone numbers (grades/sizes) once package words are gone. Also
  // eat a dash directly attached to the number (e.g. "CK-4" -> "CK", not
  // "CK-") so no orphaned hyphen is left behind.
  s = s.replace(/-?\b\d+(\.\d+)?\b/g, ' ')
  // Drop leftover single-letter noise and punctuation.
  s = s.replace(/[^A-Z0-9\s-]/g, ' ')
  // Collapse orphaned dashes: dashes flanked by spaces, dashes trailing a word
  // ("CK- " -> "CK "), dashes leading a word, and any left at the edges.
  s = s
    .replace(/\s-+\s/g, ' ')
    .replace(/([A-Z0-9])-+(\s|$)/g, '$1$2')
    .replace(/(^|\s)-+([A-Z0-9])/g, '$1$2')
  s = normalizeSpace(s).replace(/^-+\s*|\s*-+$/g, '')
  if (!s) return null
  // Keep the first few words as the product line to avoid over-long labels.
  const words = s.split(' ').slice(0, 4).join(' ')
  return titleCase(words)
}

// Derive all name-based attributes for an item at once.
export function deriveAttributes(
  name: string,
  packSize?: number,
): {
  category: string | null
  subcategory: string | null
  viscosity: string | null
  packageType: string | null
} {
  return {
    category: deriveCategory(name),
    subcategory: deriveSubcategory(name),
    viscosity: deriveViscosity(name),
    packageType: derivePackageType(name, packSize),
  }
}
