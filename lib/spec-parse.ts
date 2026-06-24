// Deterministic, brand-free specification parser for product names.
//
// We extract the structured tokens that vendors reliably put in product names
// (SAE viscosity grades like "15W-40", ISO viscosity grades like "ISO 46") and
// build a stable grouping signature from them. This replaced an AI spec step
// that silently dropped the majority of products and produced inconsistent
// categories, which caused both missing matches and over-loose groups.
//
// Grouping rules (per product decisions):
//  - Engine/gear oils: grouped by VISCOSITY ONLY (e.g. all 15W-40 engine oils
//    match across brands, even when a vendor omits the API grade like "CK-4").
//  - Industrial oils (hydraulic/compressor/turbine/etc.) with an ISO grade are
//    grouped by category + ISO grade.
//  - Anything without a parseable SAE/ISO viscosity (ATF, grease, antifreeze,
//    brake fluid, DEF, monograde, etc.) returns null and is NOT auto-grouped.

export type ParsedSpec = {
  // Stable, lowercase grouping key, e.g. "engine oil|15w-40".
  specKey: string
  // Coarse brand-free category for display/columns.
  category: string
  // Normalized viscosity for display, e.g. "15W-40", "ISO 46".
  viscosity: string
  // Brand-free human-readable canonical name, e.g. "Engine Oil 15W-40".
  displayName: string
}

// Standard ISO viscosity grades (ISO 3448). Used to distinguish a real grade
// from an incidental number such as a pack size (e.g. "205L", "20L", "1040").
const ISO_VG = new Set([
  2, 3, 5, 7, 10, 15, 22, 32, 46, 68, 100, 150, 220, 320, 460, 680, 1000, 1500,
])

// Title-case a lowercase category for display.
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function parseProductSpec(rawName: string): ParsedSpec | null {
  if (!rawName) return null
  const name = ` ${rawName.toUpperCase()} `

  // 1) SAE multigrade viscosity: 15W-40, 15W40, 0W20, 5W-30, 20W50, 0W-16...
  // Require a 1-2 digit number, W, optional dash, then 1-3 digit number.
  const sae = name.match(/\b(\d{1,2})W-?(\d{1,3})\b/)
  if (sae) {
    const viscosity = `${sae[1]}W-${sae[2]}`
    // Distinguish gear/axle oils from engine oils. Engine multigrades use a
    // winter grade of 0W-25W; SAE W-grades of 70 and up (75W-90, 80W-90,
    // 85W-140) are always gear/axle oils. Also catch explicit gear keywords.
    const winterGrade = Number(sae[1])
    const isGear =
      winterGrade >= 70 ||
      /\b(GEAR|GL-?[45]|AXLE|DIFFERENTIAL|MTF|MANUAL TRANS|TRANSAXLE|SYNGEAR|TRAXON|TRITON)\b/.test(
        name,
      )
    const category = isGear ? 'gear oil' : 'engine oil'
    return {
      specKey: `${category}|${viscosity.toLowerCase()}`,
      category,
      viscosity,
      displayName: `${titleCase(category)} ${viscosity}`,
    }
  }

  // 2) Industrial oils with an ISO viscosity grade. Only group when there is a
  // recognizable industrial-oil category keyword AND a valid ISO grade, to
  // avoid loosely merging unrelated products.
  let industrialCat: string | null = null
  if (/\b(HYDRAULIC|HYDR|HYD|AW)\b/.test(name)) industrialCat = 'hydraulic oil'
  else if (/\b(COMPRESSOR|COMPRO)\b/.test(name)) industrialCat = 'compressor oil'
  else if (/\bTURBINE\b/.test(name)) industrialCat = 'turbine oil'
  else if (/\b(WAY|SLIDE)\b/.test(name)) industrialCat = 'way oil'
  else if (/\b(CIRCULAT\w*|R&O|RANDO)\b/.test(name)) industrialCat = 'circulating oil'
  else if (/\bSPINDLE\b/.test(name)) industrialCat = 'spindle oil'

  if (industrialCat) {
    // Find a bare number that is a valid ISO grade and is NOT immediately part
    // of a pack-size token (e.g. "68 205L" -> 68 is the grade, 205 is a pack).
    const isoMatch = name.match(
      /\b(\d{2,4})\b(?!\s*(?:L|ML|US|USG|GAL|P|KG|X\d|\/))/g,
    )
    if (isoMatch) {
      for (const tok of isoMatch) {
        const n = Number(tok)
        if (ISO_VG.has(n)) {
          const viscosity = `ISO ${n}`
          return {
            specKey: `${industrialCat}|iso ${n}`,
            category: industrialCat,
            viscosity,
            displayName: `${titleCase(industrialCat)} ${viscosity}`,
          }
        }
      }
    }
  }

  // 3) No reliable viscosity grade -> do not auto-group.
  return null
}
