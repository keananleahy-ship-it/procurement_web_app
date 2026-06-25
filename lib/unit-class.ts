// Unit class for an item: the dimension its price is compared on.
//   'volume' -> normalized to US gallons (fluids)
//   'weight' -> normalized to pounds (greases)
//   'each'   -> per-piece (filters, parts) — excluded from gallon/pound math
//
// Derived from the normalized base unit via baseKind, with an optional
// per-vendor override: a vendor may map a token (e.g. a filter code "AF") to a
// unit class so parts are always treated per-piece even if a stray number was
// parsed. Pure module — any profile/text is passed in.

import { baseKind } from './price-basis'
import type { VendorProfile } from './vendor-profile'

export type UnitClass = 'volume' | 'weight' | 'each'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function deriveUnitClass(
  baseUnit: string | null | undefined,
  opts?: { profile?: VendorProfile; text?: string | null },
): UnitClass {
  // A vendor-specific unit-class token wins (e.g. "AF"/"OF" filter codes).
  const profile = opts?.profile
  const text = (opts?.text ?? '').toLowerCase()
  if (profile && text) {
    for (const [token, cls] of profile.unitClasses) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(token)}(?![a-z0-9])`, 'i')
      if (re.test(text)) return cls
    }
  }
  const kind = baseKind(baseUnit)
  if (kind === 'volume') return 'volume'
  if (kind === 'weight') return 'weight'
  return 'each'
}
