// Per-vendor nomenclature profile.
//
// Different vendors describe the same physical things with wildly different
// shorthand: ALS writes "EPACK" and "275 Tote", Shell writes "6*1qt", "KAR",
// and "ugl". Rather than bake every vendor's quirks into one global parser,
// each vendor accumulates its own dictionary of token->meaning mappings. The
// deterministic parser (lib/container-infer.ts) and the AI extractor both
// consult this profile so they intuit a given vendor's style.
//
// This module is PURE: it turns a flat list of mapping rows (seed defaults +
// rows loaded from the database) into a fast lookup structure. DB access lives
// in the route/actions, never here.

import { normalizeTier, type BaseOilTier } from '@/lib/oil-tier'

export type TokenKind =
  | 'unit'
  | 'separator'
  | 'container'
  | 'unit_class'
  | 'oil_tier'
export type TokenSource = 'seed' | 'learned' | 'manual'
export type UnitClass = 'volume' | 'weight' | 'each'

// One row from the vendor dictionary (shape mirrors vendor_token_mappings).
export type VendorTokenRow = {
  token: string
  kind: TokenKind
  value: string
  source?: TokenSource
}

// Resolved, ready-to-query profile for a single vendor.
export type VendorProfile = {
  // token -> canonical unit alias understood by normalizeContainer (e.g.
  // 'ugl' -> 'gal').
  unitAliases: Map<string, string>
  // Extra pack-multiplier separators beyond the built-in '/' (e.g. '*').
  separators: Set<string>
  // token -> fixed container capacity in US gallons (e.g. 'epack' -> 6).
  containers: Map<string, number>
  // token -> forced unit class (e.g. an 'af' filter code -> 'each').
  unitClasses: Map<string, UnitClass>
  // token -> base-oil composition tier (e.g. Petro-Canada 'uhp' ->
  // 'full-synthetic', 'shp' -> 'synthetic-blend', 'hp' -> 'conventional').
  // Used by spec parsing so this vendor's brand-coded composition is observed
  // when matching products across vendors.
  oilTiers: Map<string, BaseOilTier>
}

// Seed dictionary applied to EVERY vendor. These reproduce the conventions that
// were previously hard-coded across the parser, so behavior is unchanged before
// any per-vendor learning happens. Per-vendor DB rows override these.
export const SEED_TOKENS: VendorTokenRow[] = [
  // Pack separators. '/' is always understood; '*' is common (Shell, others).
  { token: '/', kind: 'separator', value: '/', source: 'seed' },
  { token: '*', kind: 'separator', value: '*', source: 'seed' },
  // Unit aliases -> canonical words normalizeContainer understands.
  { token: 'ugl', kind: 'unit', value: 'gal', source: 'seed' },
  { token: 'ug', kind: 'unit', value: 'gal', source: 'seed' },
  { token: 'ug6', kind: 'unit', value: 'gal', source: 'seed' },
  { token: 'usg', kind: 'unit', value: 'gal', source: 'seed' },
  // Fixed-size branded boxes (US gallons).
  { token: 'epack', kind: 'container', value: '6', source: 'seed' },
  { token: 'e-pack', kind: 'container', value: '6', source: 'seed' },
  { token: 'ecopack', kind: 'container', value: '6', source: 'seed' },
  { token: 'petropak', kind: 'container', value: '6', source: 'seed' },
  { token: 'petro-pak', kind: 'container', value: '6', source: 'seed' },
]

const SOURCE_RANK: Record<TokenSource, number> = {
  seed: 0,
  learned: 1,
  manual: 2,
}

// Build a queryable profile from seed defaults + vendor-specific rows. When the
// same (token, kind) appears more than once, the highest-ranked source wins
// (manual > learned > seed).
export function buildVendorProfile(rows: VendorTokenRow[]): VendorProfile {
  const best = new Map<string, VendorTokenRow>()
  for (const row of [...SEED_TOKENS, ...rows]) {
    const token = row.token.trim().toLowerCase()
    if (!token) continue
    const key = `${row.kind}:${token}`
    const existing = best.get(key)
    const rank = SOURCE_RANK[row.source ?? 'learned']
    if (!existing || rank >= SOURCE_RANK[existing.source ?? 'learned']) {
      best.set(key, { ...row, token })
    }
  }

  const unitAliases = new Map<string, string>()
  const separators = new Set<string>()
  const containers = new Map<string, number>()
  const unitClasses = new Map<string, UnitClass>()
  const oilTiers = new Map<string, BaseOilTier>()

  for (const row of best.values()) {
    switch (row.kind) {
      case 'unit':
        unitAliases.set(row.token, row.value.trim().toLowerCase())
        break
      case 'separator':
        separators.add(row.value.trim())
        break
      case 'container': {
        const gal = Number.parseFloat(row.value)
        if (gal > 0) containers.set(row.token, gal)
        break
      }
      case 'unit_class': {
        const v = row.value.trim().toLowerCase()
        if (v === 'volume' || v === 'weight' || v === 'each') {
          unitClasses.set(row.token, v)
        }
        break
      }
      case 'oil_tier': {
        const tier = normalizeTier(row.value)
        if (tier) oilTiers.set(row.token, tier)
        break
      }
    }
  }

  return { unitAliases, separators, containers, unitClasses, oilTiers }
}

// An empty profile (seed tokens only) for callers without a specific vendor.
export function defaultProfile(): VendorProfile {
  return buildVendorProfile([])
}

// Infer token->meaning mappings to LEARN from a reviewer's correction. Given the
// raw container text and the size the reviewer settled on, return the new
// mappings worth remembering for this vendor. Deliberately CONSERVATIVE: it only
// emits a mapping when the signal is unambiguous, since a wrong auto-learned rule
// would silently mis-parse future imports. The manual editor covers the rest.
//
//  - separator: a non-alphanumeric char sitting between two numbers (e.g. the
//    '*' in "6*1qt") that the profile doesn't already know.
//  - container: a single alphabetic token paired with a leading count, where the
//    reviewer's gallons divide evenly by that count (e.g. "12 KAR" -> 3 gal each
//    means 'kar' = 3 gal), OR a bare alphabetic token with the gallons as-is.
export function inferLearnableTokens(
  containerRaw: string,
  corrected: { packSize: number; baseUnit: string | null },
  profile: VendorProfile,
): VendorTokenRow[] {
  const raw = (containerRaw ?? '').trim().toLowerCase()
  if (!raw) return []
  const out: VendorTokenRow[] = []

  // 1) Unknown pack separator between two digits.
  const sepMatch = raw.match(/\d\s*([^a-z0-9\s.])\s*\d/)
  if (sepMatch) {
    const sep = sepMatch[1]
    if (sep !== '/' && !profile.separators.has(sep)) {
      out.push({ token: sep, kind: 'separator', value: sep, source: 'learned' })
    }
  }

  // 2) Fixed container token, only when the corrected size is volume (gallons).
  const isVolume = /gal|usg/.test((corrected.baseUnit ?? '').toLowerCase())
  if (isVolume && corrected.packSize > 0) {
    // "<count> <token>" or just "<token>" — token is purely alphabetic, >=3
    // chars, and not already a known unit/container/separator word.
    const m = raw.match(/^(\d+(?:\.\d+)?)?\s*([a-z][a-z-]{2,})$/)
    if (m) {
      const count = m[1] ? Number.parseFloat(m[1]) : 1
      const token = m[2]
      const known =
        profile.containers.has(token) ||
        profile.unitAliases.has(token) ||
        ['drum', 'pail', 'tote', 'ibc', 'case', 'pack', 'bulk'].includes(token)
      const perUnit = count > 0 ? corrected.packSize / count : 0
      // Only learn a clean, sensible capacity (avoids noise from odd splits).
      if (!known && perUnit > 0 && Number.isFinite(perUnit)) {
        out.push({
          token,
          kind: 'container',
          value: String(Number(perUnit.toFixed(4))),
          source: 'learned',
        })
      }
    }
  }

  return out
}

// A compact, human-readable summary of a vendor's non-seed conventions, injected
// into the AI extraction prompt so the model intuits this vendor's style.
// Returns '' when the vendor has only seed defaults (nothing vendor-specific).
export function describeProfileForPrompt(rows: VendorTokenRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    const token = row.token.trim()
    if (!token) continue
    switch (row.kind) {
      case 'unit':
        lines.push(`- "${token}" is the unit ${row.value} (treat as ${row.value})`)
        break
      case 'separator':
        lines.push(
          `- "${token}" is a pack multiplier (e.g. 6${token}1qt means 6 x 1 quart)`,
        )
        break
      case 'container':
        lines.push(`- "${token}" is a container holding ${row.value} US gallons`)
        break
      case 'unit_class':
        lines.push(`- "${token}" indicates a ${row.value} item`)
        break
      case 'oil_tier':
        lines.push(
          `- "${token}" indicates a ${row.value.replace(/-/g, ' ')} base oil`,
        )
        break
    }
  }
  return lines.join('\n')
}
