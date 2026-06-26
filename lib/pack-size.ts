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

// A family groups closely-related container sizes (e.g. a 205 L "54.16 gal"
// drum and a 55 gal drum) under one recognizable name, so the Compare filter
// can offer them as a single selectable bucket.
export type PackFamily = {
  // Stable key for the family bucket.
  key: string
  // Recognizable container name, e.g. "Drum (~55 gal / 205 L)".
  label: string
  // Sort weight (ascending) for ordering family chips.
  sort: number
}

const GAL_PER_LITRE = 1 / 3.785411784
const LB_PER_KG = 2.2046226

// Named volume containers, banded by canonical US-gallon capacity. Upper bounds
// are chosen to absorb supplier-to-supplier rounding (e.g. 54 / 54.16 / 55 gal
// all land in "Drum").
const VOLUME_FAMILIES: { maxGal: number; key: string; label: string; sort: number }[] = [
  { maxGal: 0.9, key: 'vol-litre', label: 'Litre / quart', sort: 1 },
  // Jugs and small cases are treated as one "Cases" family — the distinction
  // isn't meaningful for procurement comparison.
  { maxGal: 4.7, key: 'vol-case', label: 'Cases (≤4 gal)', sort: 3 },
  { maxGal: 9, key: 'vol-pail', label: 'Pail (~5-6 gal / 20 L)', sort: 4 },
  { maxGal: 30, key: 'vol-keg', label: 'Keg (~16 gal / 60 L)', sort: 5 },
  { maxGal: 120, key: 'vol-drum', label: 'Drum (~55 gal / 205 L)', sort: 6 },
  { maxGal: Number.POSITIVE_INFINITY, key: 'vol-tote', label: 'Tote / IBC (~275 gal / 1040 L)', sort: 7 },
]

// Named weight containers, banded by canonical pound capacity.
const WEIGHT_FAMILIES: { maxLb: number; key: string; label: string; sort: number }[] = [
  { maxLb: 20, key: 'wt-small', label: 'Small pack (≤20 lb)', sort: 11 },
  { maxLb: 80, key: 'wt-pail', label: 'Pail (~35 lb)', sort: 12 },
  { maxLb: 200, key: 'wt-keg', label: 'Keg (~120 lb)', sort: 13 },
  { maxLb: 600, key: 'wt-drum', label: 'Drum (~400 lb)', sort: 14 },
  { maxLb: Number.POSITIVE_INFINITY, key: 'wt-bulk', label: 'Bulk (>600 lb)', sort: 15 },
]

// Classify an offer into a named container family. Bulk/decant/unspecified and
// per-piece offers keep their own families; sized offers are converted to a
// canonical measure (gallons or pounds) and matched to a standard container.
export function packFamily(
  packSize: number,
  baseUnit: string | null,
  productName: string,
): PackFamily {
  const info = packInfo(packSize, baseUnit, productName)

  if (info.kind === 'bulk') return { key: 'fam:bulk', label: 'Bulk', sort: 100 }
  if (info.kind === 'decant') return { key: 'fam:decant', label: 'Decant', sort: 101 }
  if (info.kind === 'unspecified') {
    return { key: 'fam:unspecified', label: 'Unspecified', sort: 9999 }
  }

  const unit = unitWord(baseUnit)

  if (unit === 'gal' || unit === 'L') {
    const gal = unit === 'L' ? packSize * GAL_PER_LITRE : packSize
    const band = VOLUME_FAMILIES.find((b) => gal <= b.maxGal) ?? VOLUME_FAMILIES[VOLUME_FAMILIES.length - 1]
    return { key: `fam:${band.key}`, label: band.label, sort: band.sort }
  }

  if (unit === 'lb' || unit === 'kg') {
    const lb = unit === 'kg' ? packSize * LB_PER_KG : packSize
    const band = WEIGHT_FAMILIES.find((b) => lb <= b.maxLb) ?? WEIGHT_FAMILIES[WEIGHT_FAMILIES.length - 1]
    return { key: `fam:${band.key}`, label: band.label, sort: band.sort }
  }

  if (unit === 'ea') {
    return { key: 'fam:each', label: 'Each / count', sort: 20 }
  }

  // Unknown unit: the size is its own family so it still appears as a chip.
  return { key: `fam:${info.key}`, label: info.label, sort: info.sort }
}
