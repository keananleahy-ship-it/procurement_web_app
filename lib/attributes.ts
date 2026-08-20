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
  | 'brand'
  | 'category'
  | 'application'
  | 'subcategory'
  | 'viscosity'
  | 'packageType'

export type AttributeDef = {
  key: AttributeKey
  label: string
}

// Shared attribute defs, in the canonical drill-down order:
// category > application > subcategory (formulation) > viscosity > package,
// with supplier and brand as the outer product-only levels. "Application" is
// the end-use / duty (Heavy Duty Diesel, Industrial, ...); "Subcategory" is the
// formulation / base oil (Full Synthetic, Synthetic Blend, Conventional).
export const ALL_ATTRIBUTES: AttributeDef[] = [
  { key: 'supplier', label: 'Supplier' },
  { key: 'brand', label: 'Brand' },
  { key: 'category', label: 'Category' },
  { key: 'application', label: 'Application / Duty' },
  { key: 'subcategory', label: 'Formulation' },
  { key: 'viscosity', label: 'Viscosity' },
  { key: 'packageType', label: 'Package size' },
]

// Attributes available on the Products screen. Each product has exactly one
// supplier, brand, and pack size, so all apply.
export const PRODUCT_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES

// The default Products grouping: category > application > subcategory >
// viscosity > package (supplier and brand stay available as optional levels).
export const PRODUCT_DEFAULT_GROUP_BY: AttributeKey[] = [
  'category',
  'application',
  'subcategory',
  'viscosity',
  'packageType',
]

// Compare compares suppliers/pack sizes side-by-side *inside* each card, and a
// comparison row can span several brands, so all three are excluded here.
export const COMPARE_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES.filter(
  (a) =>
    a.key !== 'supplier' && a.key !== 'packageType' && a.key !== 'brand',
)

// A canonical item spans vendors, brands, and pack sizes, so it only carries
// the item-intrinsic attributes.
export const CANONICAL_ATTRIBUTES: AttributeDef[] = ALL_ATTRIBUTES.filter(
  (a) =>
    a.key === 'category' ||
    a.key === 'application' ||
    a.key === 'subcategory' ||
    a.key === 'viscosity',
)

// Label shown for items missing a value for the grouping attribute.
export function emptyLabelFor(key: AttributeKey): string {
  switch (key) {
    case 'supplier':
      return 'No supplier'
    case 'brand':
      return 'No brand'
    case 'category':
      return 'Uncategorized'
    case 'application':
      return 'No application'
    case 'subcategory':
      return 'No formulation'
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
    test: /GREASE|\bNLGI\b|#\s*\d{1,2}\b|MULTIPLEX|DYNALIFE|OMNIGUARD|DUOLEC|\bMOLY\b|LITHIUM|POLYUREA|\bGADUS\b|ALVANIA|RETINAX|\bPEERLESS\b|\bPRECISION\b|\bGREASI/,
  },
  {
    label: 'Compressor Fluid',
    test: /COMPRESSOR|COMPRO|PAG\s*COMP|\bCOMP\b|SYNDURO|\bPZA\b|AIR\s*COMP|\bCORENA\b/,
  },
  {
    label: 'Transmission Fluid',
    test: /\bATF\b|ATF\s*\+?\s*4|ATF\s*D|TRANSMISSION|TRANSOIL|POWERTRAN|POWERDRIVE|DURATRAN|\bTRANS\b|\bMV\b|DEXRON|MERCON|DURADRIVE/,
  },
  {
    label: 'Antifreeze & Coolant',
    test: /ANT[I]?\s*-?FRE?E?ZE|ANTFRZ|COOLANT|\bAF\b|AF\/CL|\d{2}\/\d{2}|SHELLZONE|DEX-?COOL|PRESTONE|\bZEREX\b|FLEET\s*(CHARGE|COOL)|\bELC\b|\bOAT\b/,
  },
  { label: 'Turbine Oil', test: /TURBINE|\bTURBO\b|TURBOFLO|SUNVIS/ },
  {
    label: 'Circulating / R&O Oil',
    test: /R\s*&\s*O|\bR\s+O\b|RUST.*OXID|CIRCULAT|\bARDEE\b|\bMORLINA\b/,
  },
  {
    label: 'Hydraulic Fluid',
    test: /HYDRAULIC|HYDREX|\bHVI\b|\bAW\s*\d|\bHYD\b|POWERFLOW|TELLUS|HYDRO|\bHARMONY\b/,
  },
  {
    label: 'Gear Oil',
    test: /\bGEAR\b|\bEP\s*\d|\b80W|\b85W|\b75W|\bGL-?\d|OMALA|\bSPIRAX\b|\bTRAXON\b|\bMEROPA\b/,
  },
  { label: 'Rock Drill Oil', test: /ROCK\s*DRILL/ },
  {
    label: 'Engine Oil',
    test: /ENGINE|MOTOR\s*OIL|\bDURON\b|\b\d{1,2}W-?\d{2}\b|\bSAE\b|DIESEL|\bCF\b|\bCK-?4\b|ROTELLA|RIMULA|MYSELLA|ARGINA|SENTRON|\bDELO\b|DELVAC|\bRUBIA\b/,
  },
  { label: 'Metalworking Fluid', test: /METALWORK|CUTTING|SOLUBLE/ },
  { label: 'Solvent & Cleaner', test: /SOLVENT|CLEAN(ING|ER)?|FLUSH(ING)?|DEGREAS/ },
  { label: 'Chain & Bar Oil', test: /\bCHAIN\b|\bBAR\b\s*OIL|CHAINSAW/ },
]

// Application / duty ("subcategory"). Ordered, first match wins, so the more
// specific end use is checked before the generic industrial fallback. These
// key off end-use signals in the name (API service categories, product
// families, application words), NOT brand names. Left null when nothing
// clearly indicates an application, so a reviewer can assign it.
const APPLICATION_PATTERNS: { label: string; test: RegExp }[] = [
  { label: 'Aviation', test: /AVIATION|\bAERO\b|\b5606\b/ },
  { label: 'Marine', test: /\bMARINE\b|OUTBOARD/ },
  {
    label: 'Food Grade',
    test: /FOOD\s*GRADE|\bFG\b|PURITY|WHITE\s*OIL|\bH1\b|\bNSF\b/,
  },
  {
    // Diesel / fleet engine oils. Checked before Passenger Car so dual-rated
    // oils (e.g. "CK-4/SN") land under the heavier duty.
    label: 'Heavy Duty Diesel',
    test: /HEAVY\s*DUTY\s*DIESEL|\bHDD\b|\bDIESEL\b|\bC[IJKF]-?4\b|\bCH-?4\b|DURON|GUARDOL|\bFLEET\b|SUPER-?\s*D\b|\bT5X\b|SUPER\s*C\b/,
  },
  {
    // Gasoline passenger-car engine oils, signalled by ILSAC GF-x or API S*.
    label: 'Passenger Car',
    test: /\bGF-?\d\b|\bILSAC\b|\bPCMO\b|PASSENGER|GASOLINE|\bS[NPMLJ]\/GF|\bAPI\s*S[NPMLJ]\b|\bS[NP]\b/,
  },
  {
    // Off-highway / heavy-equipment drivetrain & transmission oils.
    label: 'Off-Highway & Drivetrain',
    test: /\bTO-?4\b|PRODURO|POWERDRIVE|POWERTRAN|DURATRAN|\bUTTO\b|\bSTOU\b|TRACTOR|AGRICULT|HYDROSTATIC/,
  },
  {
    // Industrial plant lubricants: hydraulics, gears, turbines, compressors,
    // circulating / R&O, rock drill, metalworking, way/slideway oils.
    label: 'Industrial',
    test: /HYDRAULIC|\bHVI\b|\bAW\s*\d|TURBINE|COMPRESSOR|R\s*&\s*O|\bR\s+O\b|RUST.*OXID|CIRCULAT|ROCK\s*DRILL|METALWORK|CUTTING|SOLUBLE|SLIDEWAY|\bWAY\s*OIL\b|HEAT\s*TRANSFER|SYNDUSTRIAL/,
  },
]

// Formulation ("subcategory") is a single hierarchy level whose *vocabulary is
// category-dependent*. For most categories (engine/gear/transmission oils) the
// meaningful axis is base-oil type — Conventional / Synthetic Blend / Full
// Synthetic — captured by FORMULATION_PATTERNS below. For hydraulic fluids the
// base-oil type is not the distinguishing characteristic; the additive / spec
// chemistry is (AW, MV/HVI, zinc-free/ashless, R&O), so hydraulics use their
// own HYDRAULIC_FORMULATION_PATTERNS instead. deriveSubcategory() picks the
// right vocabulary from the item's category.

// Base-oil formulation (default vocabulary). Ordered, first match wins.
// Synthetic Blend MUST be checked before Full Synthetic because a blend is
// often written as "SYN BLEND" / "SYN BLD" and would otherwise match the bare
// "SYN" in the Full Synthetic rule (this was the "SYN BLD -> Full Synthetic"
// mislabel bug). Left null when the name gives no formulation signal.
const FORMULATION_PATTERNS: { label: string; test: RegExp }[] = [
  {
    label: 'Synthetic Blend',
    // Covers SYN BLEND, SYNBLEND, SYN-BLEND, SYN BLD, SYNBLD, SEMI SYN, and the
    // standalone BLEND / BLD / SB / S/B abbreviations suppliers use.
    test: /SYN(THETIC)?\s*-?\s*(BLEND|BLD)|SEMI-?\s*SYN(THETIC)?|\bBLEND\b|\bBLD\b|\bS\/?B\b/,
  },
  {
    label: 'Full Synthetic',
    test: /FULL(Y)?\s*SYN(THETIC)?|100%\s*SYN(THETIC)?|\bSYNTHETIC\b|\bSYN\b|\bFS\b|\bPAO\b|\bESTER\b/,
  },
  {
    label: 'Conventional',
    test: /CONVENTIONAL|\bMINERAL\b|\bCONV\b|PARAFFINIC|GROUP\s*[I1]\b/,
  },
]

// Hydraulic-fluid formulation vocabulary, keyed off additive / spec chemistry
// rather than base oil. Ordered, FIRST MATCH WINS, most specific first:
//   1. Zinc-Free HVI  — ashless AND high-VI (needs both signals), so it must be
//      checked before both plain Zinc-Free and MV/HVI.
//   2. Zinc-Free      — ashless / no-zinc AW (P66 NZ, Shell Tellus S3).
//   3. Full Synthetic — genuine synthetic industrial hydraulics (SYNCON,
//      SYNDUSTRIAL, HYDREX EXTREME); checked before MV/HVI so a synthetic line
//      isn't grabbed by a stray multigrade token.
//   4. MV/HVI         — high viscosity index / multigrade (HVI, MV, VX, HE,
//      All-Season, Arctic, Hyken/Glacial).
//   5. R&O            — rust & oxidation / non-AW circulating (turbine-type).
//   6. AW             — anti-wear (the workhorse HM default), matched last so
//      the more specific formulations win.
// Left null when the name gives no usable signal (reviewer assigns).
const HYDRAULIC_FORMULATION_PATTERNS: { label: string; test: RegExp }[] = [
  {
    label: 'Zinc-Free HVI',
    // Ashless + high-VI. Either the NZ line's HE/high-VI variant, or Tellus S3
    // "V" (the HVI grade of the ashless S3 line).
    test: /\bNZ\b[\s-]*HE\b|\bHE\b[\s-]*NZ\b|\bS3\s*V\b/,
  },
  {
    label: 'Zinc-Free',
    // Ashless / zinc-free anti-wear. NZ (P66 zinc-free line), Tellus S3,
    // explicit ashless / zinc-free wording.
    test: /\bNZ\b|\bS3\b|ASHLESS|ZINC[\s-]*FREE|ZINC-?LESS/,
  },
  {
    label: 'Full Synthetic',
    test: /SYNCON|SYNDUSTRIAL|\bEXTREME\b|FULL(Y)?\s*SYN(THETIC)?|100%\s*SYN(THETIC)?|\bPAO\b|\bESTER\b/,
  },
  {
    label: 'MV/HVI',
    // High viscosity index / multigrade hydraulic. HE (high-efficiency, high
    // VI) is included per the product line's positioning.
    test: /\bHVI\b|\bMV\b|MULTI-?\s*GRADE|MULTI-?\s*VIS|\bVX\b|\bHE\b|ALL[\s-]*SEASON|\bARCTIC\b|HYKEN|GLACIAL/,
  },
  {
    label: 'R&O',
    test: /R\s*&\s*O|\bR\s+O\b|RUST.*OXID|CIRCULAT/,
  },
  {
    label: 'AW',
    test: /\bAW\b|\bAW\d|ANTI-?\s*WEAR|\bHM\b/,
  },
]

// Brand / product-line mapping. Ordered, first match wins. Product-line names
// map to their parent brand (e.g. Duron/Hydrex/Turboflo -> Petro-Canada).
// Left null when the brand can't be identified, so a reviewer can assign it.
const BRAND_PATTERNS: { label: string; test: RegExp }[] = [
  { label: 'Phillips 66', test: /\bP66\b|PHILLIPS\s*66/ },
  { label: 'Kendall', test: /\bKENDALL\b/ },
  { label: 'Pennzoil', test: /\bPZL\b|PENNZOIL/ },
  { label: 'Quaker State', test: /QUAKER\s*STATE|\bQS\b/ },
  { label: 'Sunoco', test: /\bSUNOCO\b|\bSUNVIS\b|\bSUNEP\b/ },
  {
    label: 'Petro-Canada',
    test: /PETRO\s*-?\s*CANADA|\bDURON\b|\bSUPREME\b|\bHYDREX\b|\bTURBOFLO\b|\bPURITY\b|\bPRODURO\b|\bENDURATEX\b|\bENVIRON\b|\bSYNDURO\b|\bTRAXON\b|\bDURADRIVE\b|\bSENTRON\b|\bARDEE\b|\bCOMPRO\b|\bHARMONY\b|\bPEERLESS\b|\bPC\b/,
  },
  {
    label: 'Shell',
    test: /\bSHELL\b|\bTELLUS\b|\bOMALA\b|\bRIMULA\b|\bCORENA\b|\bMORLINA\b|\bGADUS\b|\bROTELLA\b|\bSPIRAX\b|\bMYSELLA\b|\bARGINA\b|\bALVANIA\b|\bRETINAX\b|SHELLZONE|\bTURBO\s*[ST]\d?\b/,
  },
  { label: 'Chevron', test: /\bCHEVRON\b|\bDELO\b|\bMEROPA\b|\bRANDO\b|\bHDAX\b/ },
  { label: 'Mobil', test: /\bMOBIL\b|DELVAC|MOBILUBE|MOBILGARD/ },
  { label: 'Total', test: /\bTOTAL\b|\bRUBIA\b|\bAZOLLA\b|\bCARTER\b/ },
  { label: 'Performax', test: /PERFORMAX|\bPERF\b/ },
  { label: 'Honda', test: /\bHONDA\b/ },
  { label: 'JCB', test: /\bJCB\b/ },
  { label: 'Mesa', test: /\bMESA\b/ },
  { label: 'Black Bear', test: /BLACK\s*BEAR/ },
  { label: 'HRC', test: /\bHRC\b/ },
]

// Controlled vocabularies exposed for the LLM fallback classifier so it emits
// exactly the same category/application labels the deterministic rules use
// (keeping grouping buckets consistent). Brand is intentionally open-ended:
// the model may return a known brand or a new one it recognizes.
export const CATEGORY_LABELS: string[] = CATEGORY_PATTERNS.map((p) => p.label)
export const APPLICATION_LABELS: string[] = APPLICATION_PATTERNS.map(
  (p) => p.label,
)
export const FORMULATION_LABELS: string[] = FORMULATION_PATTERNS.map(
  (p) => p.label,
)
// Hydraulic-fluid formulation vocabulary (additive/spec chemistry).
export const HYDRAULIC_FORMULATION_LABELS: string[] =
  HYDRAULIC_FORMULATION_PATTERNS.map((p) => p.label)
// Categories whose formulation level uses the hydraulic (additive-chemistry)
// vocabulary instead of the base-oil vocabulary.
const HYDRAULIC_FORMULATION_CATEGORIES = new Set(['Hydraulic Fluid'])

// The formulation vocabulary that applies to a given category. Exposed so the
// UI/LLM can offer exactly the values valid for the item's category.
export function formulationLabelsForCategory(
  category?: string | null,
): string[] {
  return category && HYDRAULIC_FORMULATION_CATEGORIES.has(category)
    ? HYDRAULIC_FORMULATION_LABELS
    : FORMULATION_LABELS
}
export const KNOWN_BRAND_LABELS: string[] = BRAND_PATTERNS.map((p) => p.label)
// Package-size vocabulary (drum/pail/bulk/…), for inline package-size selects.
export const PACKAGE_LABELS: string[] = PACKAGE_PATTERNS.map((p) => p.label)

// The catalog attributes a site champion may correct on the Catalog Validation
// screen. Vendor code (sku) and description (name) identify the product and are
// read-only there. Defined here (not in the server action) so client and server
// share one list.
export const VALIDATION_ATTRIBUTE_KEYS: AttributeKey[] = [
  'category',
  'application',
  'subcategory',
  'viscosity',
  'packageType',
]

// The controlled vocabulary a UI should offer for a given attribute, or null
// when the attribute is free-form (viscosity spans too many grades; supplier
// and brand are open-ended). `category` scopes the formulation vocabulary.
// Used by the catalog-validation inline editor to constrain corrections to
// exactly the labels the grouping/derivation logic recognizes.
export function vocabularyFor(
  key: AttributeKey,
  category?: string | null,
): string[] | null {
  switch (key) {
    case 'category':
      return CATEGORY_LABELS
    case 'application':
      return APPLICATION_LABELS
    case 'subcategory':
      return formulationLabelsForCategory(category)
    case 'packageType':
      return PACKAGE_LABELS
    case 'brand':
      return KNOWN_BRAND_LABELS
    case 'viscosity':
    case 'supplier':
      return null
  }
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

// The category label used for NSF H1 food-grade lubricants.
export const FOOD_GRADE_CATEGORY = 'Food Grade Lubricant'

// Food-grade (NSF H1) lubricants are a distinct commercial segment: they are
// certified for incidental food contact and priced accordingly, so they must
// never be pooled with — or price-compared against — standard industrial
// product, even when the base type and viscosity grade line up. A food-grade
// "Purity FG AW Hydraulic 46" is NOT interchangeable with a standard AW
// hydraulic ISO 46. We trust the stored category when present (it is the
// classifier's authoritative output) and fall back to the name so the check
// also works before a record has been classified.
export function isFoodGrade(input: {
  category?: string | null
  name?: string | null
}): boolean {
  if (input.category != null && input.category !== '') {
    return input.category === FOOD_GRADE_CATEGORY
  }
  if (input.name) return deriveCategory(input.name) === FOOD_GRADE_CATEGORY
  return false
}

// Two lubricants may only be matched/compared when they sit on the same side of
// the food-grade divide: either both food-grade or both standard.
export function sameFoodGradeSegment(
  a: { category?: string | null; name?: string | null },
  b: { category?: string | null; name?: string | null },
): boolean {
  return isFoodGrade(a) === isFoodGrade(b)
}

export function deriveViscosity(name: string): string | null {
  const upper = name.toUpperCase()
  // Coolant blend ratios like 50/50 are not a viscosity grade.
  const withoutRatios = upper.replace(/\d{2}\/\d{2}/g, ' ')
  // SAE multigrade, e.g. 15W-40, 5W30, 80W-90. Suppliers write the same grade
  // with or without the hyphen ("10W30" vs "10W-30"), and often glue it to
  // surrounding text with a product code that ends in digits
  // ("RotellaT610W30CK4" = T6 + 10W-30). Anchoring the winter number to the
  // real SAE winter grades (engine 0..25, gear 70..85) lets us split the grade
  // off the product code without a \d lookbehind, while the trailing (?!\d)
  // still prevents slicing a longer number. Always emit the canonical
  // hyphenated form so every spelling collapses to one value.
  // Winter number is anchored to real SAE winter grades (engine 0..25, gear
  // 70..85). Second number is 1-3 digits to also catch newer thin grades like
  // 0W-8 / 0W-16, with (?!\d) so a longer number isn't sliced.
  const sae = withoutRatios.match(
    /(0|5|10|15|20|25|70|75|80|85)W\s*-?\s*(\d{1,3})(?!\d)/,
  )
  if (sae) return `SAE ${sae[1]}W-${sae[2]}`
  // A single "W" grade, e.g. 10W or 30W (straight-grade transmission / rock
  // drill oils). Includes summer monogrades 30..60 that some products still
  // suffix with a W. Runs after the multigrade match above.
  const saeSingle = withoutRatios.match(
    /(0|5|10|15|20|25|30|40|50|60|70|75|80|85)W(?![\d-]|\s*\d)/,
  )
  if (saeSingle) return `SAE ${saeSingle[1]}W`
  // ISO VG: find any standalone number that is a known grade, skipping numbers
  // immediately followed by a unit (205L, 20 KG) which are pack sizes. The tiny
  // grades (2/3/5/7) collide with grease NLGI numbers and product-code suffixes
  // (e.g. "Gadus S2 V220 2"), so only accept them when the name explicitly says
  // ISO/VG; otherwise require a common bare industrial grade (>= 22).
  const hasIsoContext = /\b(ISO\s*VG|ISO|VG)\b/.test(withoutRatios)
  const numbers = withoutRatios.matchAll(/\b(\d{1,4})\b(?!\s*(L|ML|KG|USG|X))/g)
  for (const m of numbers) {
    const n = Number(m[1])
    if (!ISO_VG_GRADES.includes(n)) continue
    if (n < 22 && !hasIsoContext) continue
    return 'ISO VG ' + n
  }
  return null
}

// Product categories that are inherently industrial-plant lubricants. When a
// name carries no more-specific application signal, membership in one of these
// categories is itself the application/duty.
const INDUSTRIAL_CATEGORIES = new Set([
  'Hydraulic Fluid',
  'Gear Oil',
  'Compressor Fluid',
  'Turbine Oil',
  'Circulating / R&O Oil',
  'Heat Transfer Fluid',
  'Rock Drill Oil',
  'Metalworking Fluid',
  'Grease',
  'Chain & Bar Oil',
])

// Application / duty (stored in the `application` column). Returns a value from
// a controlled set (Aviation, Heavy Duty Diesel, Industrial, ...) or null when
// nothing indicates an end use. Checks explicit name signals first, then falls
// back to the category for inherently-industrial product classes. This
// deliberately does NOT fall back to the brand/product-line name.
export function deriveApplication(
  name: string,
  category?: string | null,
): string | null {
  const upper = name.toUpperCase()
  for (const a of APPLICATION_PATTERNS) {
    if (a.test.test(upper)) return a.label
  }
  if (category && INDUSTRIAL_CATEGORIES.has(category)) return 'Industrial'
  return null
}

// Formulation (stored in the `subcategory` column). The vocabulary depends on
// the item's category: hydraulic fluids resolve to their additive-chemistry
// values (AW / MV-HVI / Zinc-Free / Zinc-Free HVI / R&O / Full Synthetic),
// everything else to base-oil values (Full Synthetic / Synthetic Blend /
// Conventional). Returns null when the name gives no formulation signal.
export function deriveSubcategory(
  name: string,
  category?: string | null,
): string | null {
  const upper = name.toUpperCase()
  const patterns =
    category && HYDRAULIC_FORMULATION_CATEGORIES.has(category)
      ? HYDRAULIC_FORMULATION_PATTERNS
      : FORMULATION_PATTERNS
  for (const f of patterns) {
    if (f.test.test(upper)) return f.label
  }
  return null
}

// Manufacturer / product-line brand. Returns a known brand or null.
export function deriveBrand(name: string): string | null {
  const upper = name.toUpperCase()
  for (const b of BRAND_PATTERNS) {
    if (b.test.test(upper)) return b.label
  }
  return null
}

// Derive all name-based attributes for an item at once.
export function deriveAttributes(
  name: string,
  packSize?: number,
): {
  brand: string | null
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
  packageType: string | null
} {
  const category = deriveCategory(name)
  return {
    brand: deriveBrand(name),
    category,
    application: deriveApplication(name, category),
    subcategory: deriveSubcategory(name, category),
    viscosity: deriveViscosity(name),
    packageType: derivePackageType(name, packSize),
  }
}
