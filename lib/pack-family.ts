// Pack-size "families" group physically similar containers so the Compare page
// can filter to like-for-like packaging. Families are measurement-aware: the
// liquid (gallon) families never absorb weight/count packs, since those aren't
// comparable containers.
//
// Rules (per product request):
//   - Bulk:  pack size exactly 1 (sold as a single unit) — overrides Cases.
//   - Liquid (volume base unit):
//       Cases  4 gal and under
//       Pails  ~5–6 gal
//       Kegs   ~15 gal
//       Drums  ~55 gal
//       Totes  ~275 gal (IBC)
//   - Other: weight/count packs not yet assigned to a family.

export type PackFamilyId =
  | 'bulk'
  | 'cases'
  | 'pails'
  | 'kegs'
  | 'drums'
  | 'totes'
  | 'other'

export const PACK_FAMILIES: {
  id: PackFamilyId
  label: string
  description: string
}[] = [
  {
    id: 'bulk',
    label: 'Bulk / Single',
    description: 'Sold as a single unit (pack size 1)',
  },
  { id: 'cases', label: 'Cases', description: 'Liquid · 4 gal and under' },
  { id: 'pails', label: 'Pails', description: 'Liquid · ~5–6 gal' },
  { id: 'kegs', label: 'Kegs', description: 'Liquid · ~15 gal' },
  { id: 'drums', label: 'Drums', description: 'Liquid · ~55 gal' },
  { id: 'totes', label: 'Totes', description: 'Liquid · ~275 gal (IBC)' },
  {
    id: 'other',
    label: 'Other',
    description: 'Weight or count packs not yet grouped',
  },
]

const VOLUME_UNITS = new Set([
  'gal',
  'gals',
  'gallon',
  'gallons',
  'usg',
  'us gal',
  'us gallon',
  'us gallons',
])

function isVolumeUnit(unit: string | null | undefined): boolean {
  if (!unit) return false
  return VOLUME_UNITS.has(unit.trim().toLowerCase())
}

// Classify a single offer into a pack family. Boundaries are set slightly wide
// so unit-conversion duplicates (e.g. 4.2268 USG = 16 L, 54.95 USG = 55 gal)
// land with their nominal container size.
export function packFamily(
  packSize: number,
  baseUnit: string | null | undefined,
): PackFamilyId {
  if (packSize === 1) return 'bulk'
  if (isVolumeUnit(baseUnit)) {
    if (packSize <= 4.5) return 'cases'
    if (packSize <= 7) return 'pails'
    if (packSize <= 30) return 'kegs'
    if (packSize <= 120) return 'drums'
    return 'totes'
  }
  return 'other'
}
