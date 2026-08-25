// Attribute-gap queue: rank the products whose MISSING attributes are what
// keep them out of spec equivalence, so data entry targets the gaps that
// actually unlock a cross-supplier comparison.
//
// Why a dedicated queue rather than the existing /validation screen: that
// screen inner-joins purchase records, so it can only reach products a site
// actually bought. Measured against live data, 1,350 of the 2,087 products
// blocked from spec-keying (65%) have no purchase record at all and are
// therefore unreachable there. Those orphans are exactly the ones suppressing
// equivalence coverage.
//
// Ranking is by UNLOCK VALUE, not by how empty a row looks:
//   1. Products one attribute away from keyable come first — filling one field
//      converts them immediately, where a 3-gap product needs three edits.
//   2. Within those, products whose peer spec is ALREADY offered by another
//      supplier rank highest, because completing them creates a real
//      cross-supplier group rather than a group of one.
//   3. Purchase volume breaks ties, so equal-unlock work happens on the spend
//      that matters first.
//
// Candidate values are read off SIBLING products that share the rest of the
// spec, never guessed: if every peer of a blank-viscosity grease is NLGI 1/2/3,
// those are the realistic options and are offered as one-click chips. The
// name-based derivation in lib/attributes.ts is deliberately not re-run here —
// it has already been applied to this catalog and yields nothing for any of the
// one-away products, so the remaining work is genuinely human judgement.

import {
  SPEC_DIMENSIONS,
  specValue,
  specGroupKey,
  type SpecDimension,
  type SpecItem,
} from '@/lib/spec-group'

/** A product's purchase volume, used only to break ranking ties. */
export type GapItem = SpecItem & { annualVolume: number }

export type GapCandidate = {
  /** Raw value as some sibling product actually spells it. */
  value: string
  /** How many peers carry it — the reason to trust it. */
  count: number
}

export type GapRow = {
  id: number
  name: string
  supplier: string | null
  annualVolume: number
  /** Dimensions with no value, in canonical order. */
  missing: SpecDimension[]
  /** Values already present, for context while filling the blank. */
  present: { dimension: SpecDimension; value: string }[]
  /**
   * Distinct OTHER suppliers already offering the spec this product would join
   * once its single gap is filled. Zero means completing it yields a group of
   * one, which unlocks no comparison — the core prioritization signal.
   */
  rivalSuppliers: number
  /** Observed sibling values for the missing dimension, most common first. */
  candidates: GapCandidate[]
}

export type GapQueue = {
  /** One attribute from keyable: the actionable queue, best-first. */
  oneAway: GapRow[]
  /** Two or more gaps: real but lower-yield work, kept visible not hidden. */
  multiGap: GapRow[]
  /** Products already fully keyed under the active dimensions. */
  complete: number
}

const DIMENSION_ORDER = SPEC_DIMENSIONS.map((d) => d.key)

/**
 * Build the gap queue for the chosen equivalence dimensions.
 *
 * The dimension set is passed in rather than fixed so the queue always reflects
 * the key the user is actually comparing on: loosening the key on the
 * equivalents screen genuinely removes work here, and tightening it adds work.
 */
export function computeGapQueue(
  items: GapItem[],
  dimensions: SpecDimension[],
): GapQueue {
  const active = DIMENSION_ORDER.filter((d) => dimensions.includes(d))
  if (active.length === 0) {
    return { oneAway: [], multiGap: [], complete: 0 }
  }

  // Index keyable products by every "one dimension removed" partial key. A
  // product missing exactly that dimension shares this partial key with its
  // peers, which is what makes both the rival-supplier count and the candidate
  // values observed facts rather than inferences.
  const suppliersByPartial = new Map<string, Set<string>>()
  const valuesByPartial = new Map<string, Map<string, number>>()

  for (const item of items) {
    if (specGroupKey(item, active) == null) continue
    for (const omitted of active) {
      const partial = partialKey(item, active, omitted)
      const supplier = item.supplier?.trim().toLowerCase()
      if (supplier) {
        const set = suppliersByPartial.get(partial) ?? new Set<string>()
        set.add(supplier)
        suppliersByPartial.set(partial, set)
      }
      // Count the raw spelling so the chip shows the vendor's own wording.
      const raw = item[omitted]?.trim()
      if (raw) {
        const counts = valuesByPartial.get(partial) ?? new Map<string, number>()
        counts.set(raw, (counts.get(raw) ?? 0) + 1)
        valuesByPartial.set(partial, counts)
      }
    }
  }

  const oneAway: GapRow[] = []
  const multiGap: GapRow[] = []
  let complete = 0

  for (const item of items) {
    const missing = active.filter((d) => specValue(item, d) == null)
    if (missing.length === 0) {
      complete++
      continue
    }
    const present = active
      .filter((d) => specValue(item, d) != null)
      .map((d) => ({ dimension: d, value: item[d] as string }))

    let rivalSuppliers = 0
    let candidates: GapCandidate[] = []

    // Rivals and candidates are only meaningful when a single blank remains:
    // with two gaps the partial key isn't determined, so any count would be
    // speculation. Multi-gap rows are ranked by volume alone.
    if (missing.length === 1) {
      const partial = partialKey(item, active, missing[0])
      const own = item.supplier?.trim().toLowerCase()
      const suppliers = suppliersByPartial.get(partial)
      if (suppliers) {
        rivalSuppliers = [...suppliers].filter((s) => s !== own).length
      }
      const counts = valuesByPartial.get(partial)
      if (counts) {
        candidates = [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
          .slice(0, 8)
      }
    }

    const row: GapRow = {
      id: item.id,
      name: item.name,
      supplier: item.supplier,
      annualVolume: item.annualVolume,
      missing,
      present,
      rivalSuppliers,
      candidates,
    }
    if (missing.length === 1) oneAway.push(row)
    else multiGap.push(row)
  }

  oneAway.sort(
    (a, b) =>
      b.rivalSuppliers - a.rivalSuppliers ||
      b.annualVolume - a.annualVolume ||
      a.name.localeCompare(b.name),
  )
  multiGap.sort(
    (a, b) =>
      a.missing.length - b.missing.length ||
      b.annualVolume - a.annualVolume ||
      a.name.localeCompare(b.name),
  )
  return { oneAway, multiGap, complete }
}

/** Key over every active dimension except one. Assumes the rest are present. */
function partialKey(
  item: SpecItem,
  active: SpecDimension[],
  omitted: SpecDimension,
): string {
  return active
    .filter((d) => d !== omitted)
    .map((d) => `${d}=${specValue(item, d) ?? ''}`)
    .join('|')
}
