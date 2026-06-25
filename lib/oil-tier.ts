// Base-oil composition tier detection.
//
// Base-oil composition is a critical comparison axis: a 15W-40 full synthetic is
// NOT interchangeable with a 15W-40 synthetic blend or a 15W-40 conventional, so
// they must never auto-group together. This module extracts the composition tier
// from a product name using two sources of signal:
//
//   1. A global dictionary of unambiguous, industry-standard markers (full
//      words like "synthetic blend" and standard abbreviations like FS/SB/SYN).
//   2. Optional VENDOR-SPECIFIC markers, because vendors brand-code composition
//      differently — e.g. Petro-Canada uses UHP (full synthetic), SHP (blend),
//      and HP (conventional). These are ambiguous out of context ("HP" can mean
//      "high performance"), so they're scoped to the vendor that uses them via
//      the vendor nomenclature profile rather than applied globally.
//
// When no marker is found the tier is null ("unspecified"), and such products
// are kept in their own group — never merged with a typed tier — matching the
// conservative policy already used for unknown engine duty class.

export type BaseOilTier =
  | 'full-synthetic'
  | 'synthetic'
  | 'synthetic-blend'
  | 'conventional'

// Human-readable label for display names.
export const TIER_LABEL: Record<BaseOilTier, string> = {
  'full-synthetic': 'Full Synthetic',
  synthetic: 'Synthetic',
  'synthetic-blend': 'Synthetic Blend',
  conventional: 'Conventional',
}

// Global, brand-free marker rules, evaluated IN ORDER. Order matters because
// several markers are substrings of others: "synthetic blend" contains
// "synthetic", and "full synthetic" contains "synthetic", so the more specific
// tiers must be tested first. Each pattern is matched against the uppercased,
// space-padded name with word boundaries.
const GLOBAL_RULES: { tier: BaseOilTier; re: RegExp }[] = [
  // Synthetic blend / semi-synthetic (most specific — must precede synthetic).
  {
    tier: 'synthetic-blend',
    re: /\b(SYN(?:THETIC)?[\s-]*BL(?:E?N?D|D)|SEMI[\s-]*SYN(?:THETIC)?|PART[\s-]*SYN(?:THETIC)?|SB)\b/,
  },
  // Full synthetic (must precede bare synthetic).
  {
    tier: 'full-synthetic',
    re: /\b(FULL[\s-]*SYN(?:THETIC)?|100%?\s*SYN(?:THETIC)?|FS)\b/,
  },
  // Bare synthetic.
  { tier: 'synthetic', re: /\b(SYN(?:THETIC)?)\b/ },
  // Conventional / mineral.
  { tier: 'conventional', re: /\b(CONVENTIONAL|MINERAL|MIN(?:'?L)?)\b/ },
]

// Detect the base-oil tier of a product name. vendorMarkers maps a vendor's
// brand-coded token (lowercased, e.g. "uhp") to a canonical tier; these are
// checked BEFORE the global rules so a vendor's coded products resolve to their
// intended tier even when the code looks ambiguous globally.
export function detectBaseOilTier(
  rawName: string,
  vendorMarkers?: Map<string, BaseOilTier>,
): BaseOilTier | null {
  if (!rawName) return null
  const name = ` ${rawName.toUpperCase()} `

  if (vendorMarkers && vendorMarkers.size > 0) {
    // Test longer tokens first so a vendor's "UHP"/"SHP" wins over a bare "HP".
    const tokens = [...vendorMarkers.keys()].sort((a, b) => b.length - a.length)
    for (const token of tokens) {
      const tier = vendorMarkers.get(token)
      if (!tier) continue
      // Word-boundary match on the uppercased token.
      const re = new RegExp(`\\b${escapeRegExp(token.toUpperCase())}\\b`)
      if (re.test(name)) return tier
    }
  }

  for (const { tier, re } of GLOBAL_RULES) {
    if (re.test(name)) return tier
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Validate/normalize a free-text tier value (from a stored mapping) to a known
// tier, or null if unrecognized.
export function normalizeTier(value: string | null | undefined): BaseOilTier | null {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (v === 'full-synthetic' || v === 'synthetic' || v === 'synthetic-blend' || v === 'conventional') {
    return v
  }
  // Accept a few friendly aliases.
  if (v === 'full-syn' || v === 'fullsynthetic') return 'full-synthetic'
  if (v === 'blend' || v === 'semi-synthetic' || v === 'semi-syn') return 'synthetic-blend'
  if (v === 'syn') return 'synthetic'
  if (v === 'mineral' || v === 'conv') return 'conventional'
  return null
}
