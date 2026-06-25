// Derives a human-friendly container label for a price offer.
//
// Many vendor lines are sold loose by the gallon ("... BULK") or decanted from
// a drum ("... DRUM DECANT"). These are correctly stored with packSize = 1 and
// priced per gallon, but a raw "1" reads as "Unspecified" in the UI even though
// the container IS known: it's an intentional per-gallon/bulk offer. This helper
// distinguishes those intentional cases from genuinely-unknown containers so the
// Compare view can label and filter them as e.g. "1 gal (bulk)".

export type PackKind = 'sized' | 'bulk' | 'decant' | 'unspecified'

export type PackInfo = {
  kind: PackKind
  // Stable key for grouping offers into a single filter bucket.
  key: string
  // Sort weight (ascending) for ordering filter chips; unknown sorts last.
  sort: number
  // Display label, e.g. "205 litre", "1 gal (bulk)", "Unspecified".
  label: string
}

// Normalize a base unit to a short, friendly word for display.
function unitWord(baseUnit: string | null): string {
  const u = (baseUnit ?? '').trim().toLowerCase()
  if (['usg', 'gal', 'gallon', 'us gallon', 'gallons'].includes(u)) return 'gal'
  if (['litre', 'liter', 'l', 'litres', 'liters'].includes(u)) return 'L'
  if (['kg', 'kilogram', 'kilograms'].includes(u)) return 'kg'
  if (['lb', 'lbs', 'pound', 'pounds'].includes(u)) return 'lb'
  if (['each', 'ea', 'unit', 'units'].includes(u)) return 'ea'
  // Fall back to a lowercased form so casing differences ("LB" vs "lb") don't
  // create duplicate buckets.
  return (baseUnit ?? '').trim().toLowerCase()
}

export function packInfo(
  packSize: number,
  baseUnit: string | null,
  productName: string,
): PackInfo {
  // A real container capacity was parsed from the source.
  if (packSize > 1) {
    const unit = unitWord(baseUnit)
    const num = packSize.toLocaleString(undefined, { maximumFractionDigits: 2 })
    const label = unit ? `${num} ${unit}` : num
    // Key by the displayed label so capacities that round to the same value
    // (e.g. metric sizes converted to gallons) collapse into one filter chip.
    return { kind: 'sized', key: `s:${label}`, sort: packSize, label }
  }

  // packSize === 1: tell intentional bulk/decant apart from unknown containers
  // by reading the descriptor that vendors put in the product name.
  const name = (productName ?? '').toUpperCase()
  const unit = unitWord(baseUnit) || 'unit'

  if (/\bBULK\b/.test(name)) {
    return { kind: 'bulk', key: 'bulk', sort: 1.0001, label: `1 ${unit} (bulk)` }
  }
  if (/\b(DECANT|DCNT)\b/.test(name)) {
    return {
      kind: 'decant',
      key: 'decant',
      sort: 1.0002,
      label: `1 ${unit} (decant)`,
    }
  }

  return {
    kind: 'unspecified',
    key: 'unspecified',
    sort: Number.POSITIVE_INFINITY,
    label: 'Unspecified',
  }
}
