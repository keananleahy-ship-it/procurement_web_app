// Deterministic, brand-free specification parser for product names.
//
// We extract the structured tokens that vendors reliably put in product names
// (SAE viscosity grades like "15W-40", ISO viscosity grades like "ISO 46") and
// build a stable grouping signature from them. This replaced an AI spec step
// that silently dropped the majority of products and produced inconsistent
// categories, which caused both missing matches and over-loose groups.
//
// Grouping rules (per product decisions):
//  - Engine oils: grouped by DUTY CLASS + VISCOSITY. Heavy-duty (diesel) and
//    passenger/light-duty oils of the same viscosity are kept in separate
//    groups, because a 5W-30 HD diesel oil is not interchangeable with a 5W-30
//    passenger-car oil. Within a duty class they still match across brands even
//    when a vendor omits the API grade.
//  - Gear oils: grouped by viscosity only.
//  - Industrial oils (hydraulic/compressor/turbine/etc.) with an ISO grade are
//    grouped by category + ISO grade.
//  - Anything without a parseable SAE/ISO viscosity (ATF, grease, antifreeze,
//    brake fluid, DEF, monograde, etc.) returns null and is NOT auto-grouped.
//  - Base-oil composition (full synthetic / synthetic / synthetic blend /
//    conventional) is a further splitting dimension: oils that otherwise match
//    on category + viscosity are kept apart when their composition differs, and
//    products with no composition marker stay in their own "unspecified" group.

import {
  detectBaseOilTier,
  TIER_LABEL,
  type BaseOilTier,
} from '@/lib/oil-tier'

export type ParsedSpec = {
  // Stable, lowercase grouping key, e.g. "engine oil|15w-40".
  specKey: string
  // Coarse brand-free category for display/columns.
  category: string
  // Normalized viscosity for display, e.g. "15W-40", "ISO 46".
  viscosity: string
  // Brand-free human-readable canonical name, e.g. "Engine Oil 15W-40".
  displayName: string
  // Base-oil composition tier, or null when the name carries no marker.
  baseOilTier: BaseOilTier | null
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

// Detect the duty class of an engine oil from the strong, reliable signals
// vendors put in product names (API/ACEA service codes and brand families).
// Returns 'hd' (heavy-duty/diesel), 'pc' (passenger/light-duty), or null when
// no confident signal exists (those are grouped without a duty class so they
// never wrongly merge with a classified oil).
function detectEngineDuty(name: string): 'hd' | 'pc' | null {
  // Heavy-duty diesel signals:
  //  - API C-service codes: CF, CF-4, CG-4, CH-4, CI-4, CJ-4, CK-4
  //  - ACEA heavy-duty E-codes: E4/E6/E7/E8/E9/E11 (incl. forms like E8-X)
  //  - Heavy-duty brand/marketing families and keywords
  const hd =
    /\bC[FGHIJK]-?4\b/.test(name) ||
    /\bCF\b/.test(name) ||
    /\bE\d{1,2}(?:-X)?\b/.test(name) ||
    /\b(DURON|GUARDOL|POWER-?D|FLEET|DELO|ROTELLA|DELVAC|HDMO|HDEO|HEAVY[- ]?DUTY|SUPER[- ]?D|SUPER\s*HPD|TRIAX|DIESEL)\b/.test(
      name,
    )
  if (hd) return 'hd'

  // Passenger/light-duty (gasoline) signals:
  //  - API S-service codes: SG/SH/SJ/SL/SM/SN/SP
  //  - ILSAC GF grades, GM dexos, and passenger brand families
  const pc =
    /\bS[GHJLMNP]\b/.test(name) ||
    /\bGF-?[3-7]\b/.test(name) ||
    /\bILSAC\b/.test(name) ||
    /\bDEXOS\b/.test(name) ||
    /\b(SUPREME|GASOLINE|PCMO|GT-?1|SHIELD|HONDA|MOTORCYCLE|4-?STROKE|2-?STROKE|SCOOTER|EURO)\b/.test(
      name,
    )
  if (pc) return 'pc'

  return null
}

// Stable key for a product name, used to remember and re-apply manual matching
// decisions. Lowercased, punctuation collapsed to spaces, whitespace squeezed,
// so trivial formatting differences in re-imports still match the same key.
export function normalizeNameKey(rawName: string): string {
  return (rawName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Options for spec parsing. oilTierMarkers carries a vendor's brand-coded
// composition tokens (e.g. Petro-Canada "uhp" -> full-synthetic) so coded names
// resolve to the right tier; pass it when the product's vendor is known.
export type SpecParseOptions = {
  oilTierMarkers?: Map<string, BaseOilTier>
}

// Append a base-oil tier to a spec key / display name when one is known. The
// tier becomes part of the grouping signature so different compositions never
// merge; an unspecified tier adds nothing (its own group).
function applyTier(
  base: { specKey: string; displayName: string },
  tier: BaseOilTier | null,
): { specKey: string; displayName: string; baseOilTier: BaseOilTier | null } {
  if (!tier) return { ...base, baseOilTier: null }
  return {
    specKey: `${base.specKey}|${tier}`,
    displayName: `${TIER_LABEL[tier]} ${base.displayName}`,
    baseOilTier: tier,
  }
}

export function parseProductSpec(
  rawName: string,
  opts?: SpecParseOptions,
): ParsedSpec | null {
  if (!rawName) return null
  const name = ` ${rawName.toUpperCase()} `

  // Base-oil composition tier (global markers + any vendor-specific codes).
  const tier = detectBaseOilTier(rawName, opts?.oilTierMarkers)

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

    if (isGear) {
      return {
        ...applyTier(
          {
            specKey: `gear oil|${viscosity.toLowerCase()}`,
            displayName: `Gear Oil ${viscosity}`,
          },
          tier,
        ),
        category: 'gear oil',
        viscosity,
      }
    }

    // Engine oil: split by duty class so heavy-duty diesel and passenger oils
    // of the same viscosity don't merge. Unknown duty stays in its own group.
    const duty = detectEngineDuty(name)
    const dutyLabel =
      duty === 'hd'
        ? 'Heavy-Duty Engine Oil'
        : duty === 'pc'
          ? 'Passenger Engine Oil'
          : 'Engine Oil'
    // Keep the duty token in the key so groups never cross duty class.
    const keyCat = duty ? `engine oil ${duty}` : 'engine oil'
    return {
      ...applyTier(
        {
          specKey: `${keyCat}|${viscosity.toLowerCase()}`,
          displayName: `${dutyLabel} ${viscosity}`,
        },
        tier,
      ),
      category: dutyLabel.toLowerCase(),
      viscosity,
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
            ...applyTier(
              {
                specKey: `${industrialCat}|iso ${n}`,
                displayName: `${titleCase(industrialCat)} ${viscosity}`,
              },
              tier,
            ),
            category: industrialCat,
            viscosity,
          }
        }
      }
    }
  }

  // 3) No reliable viscosity grade -> do not auto-group.
  return null
}
