// OEM-specific product detection.
//
// Some products are proprietary, original-equipment-manufacturer (OEM) branded
// fluids — e.g. "Honda Genuine FS 0W20", "Acura ATF DW-1". These are locked to
// one manufacturer's brand and are not cross-shoppable against generic vendor
// products, so they are excluded from price comparison and savings analysis.
//
// IMPORTANT — brand vs. spec: an OEM name appearing mid-string usually denotes a
// SPECIFICATION the product MEETS rather than the brand selling it. For example
// "Black Bear Cat TO-4" is a generic Black Bear fluid that MEETS Caterpillar's
// TO-4 spec — it is NOT an OEM-locked product. To avoid these false positives we
// only treat a product as OEM-specific when the OEM is clearly the brand: the
// name STARTS with the OEM token, or the name pairs an OEM token with the word
// "GENUINE" (the universal marker of a first-party OEM fluid).

// Vehicle / equipment manufacturers whose first-party branded fluids are
// proprietary. Multi-word and abbreviated forms are listed explicitly.
const OEM_BRANDS = [
  'honda',
  'acura',
  'toyota',
  'lexus',
  'scion',
  'nissan',
  'infiniti',
  'subaru',
  'mazda',
  'mitsubishi',
  'hyundai',
  'genesis',
  'kia',
  'ford',
  'motorcraft',
  'lincoln',
  'gm',
  'acdelco',
  'ac delco',
  'chevrolet',
  'buick',
  'cadillac',
  'gmc',
  'mopar',
  'chrysler',
  'dodge',
  'jeep',
  'ram',
  'bmw',
  'mini',
  'mercedes',
  'mercedes-benz',
  'benz',
  'volkswagen',
  'vw',
  'audi',
  'porsche',
  'volvo',
  'land rover',
  'range rover',
  'jaguar',
  'kubota',
  'yanmar',
  'john deere',
  'deere',
  'case ih',
  'new holland',
  'allison',
  'cummins',
  'detroit diesel',
  'paccar',
  'kenworth',
  'peterbilt',
  'harley',
  'harley-davidson',
  'yamaha',
  'kawasaki',
  'suzuki',
  'sea-doo',
  'ski-doo',
  'polaris',
  'can-am',
  'mercury marine',
  'evinrude',
]

// Tokens that, combined with an OEM brand, strongly confirm a first-party fluid.
const GENUINE_RE = /\b(genuine|oem|original)\b/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Brand tokens long enough / distinctive enough to trust when paired with
// "GENUINE" anywhere in the name (avoids matching short ambiguous tokens like
// "gm"/"vw"/"ram" mid-string unless they lead the name).
const oemAlternation = OEM_BRANDS.map(escapeRe).join('|')
const LEADING_OEM_RE = new RegExp(`^\\s*(?:${oemAlternation})\\b`, 'i')
const GENUINE_OEM_RE = new RegExp(`\\b(?:${oemAlternation})\\b`, 'i')

// True when a product is a proprietary OEM-branded fluid and therefore should be
// kept out of cross-vendor comparison. Conservative by design — see file notes.
export function isOemSpecific(rawName: string | null | undefined): boolean {
  const name = (rawName ?? '').trim()
  if (!name) return false
  // 1) Name led by an OEM brand: "HONDA ...", "ACURA ...".
  if (LEADING_OEM_RE.test(name)) return true
  // 2) "GENUINE/OEM" first-party marker paired with an OEM brand anywhere.
  if (GENUINE_RE.test(name) && GENUINE_OEM_RE.test(name)) return true
  return false
}
