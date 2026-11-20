// Annual volume and spend per Snowflake business unit, kept alongside each
// regional purchase volume so a region can be drilled into its units without
// changing the grain the comparison engine works at. `costedVolume` is the
// share of volume that carried a cost, so per-unit averages stay honest.
export type UnitShare = {
  unit: string
  volume: number
  spend: number | null
  costedVolume: number
}

export const UNASSIGNED_UNIT = 'Unassigned'

export function mergeUnitShares(
  ...lists: (UnitShare[] | null | undefined)[]
): UnitShare[] | null {
  const byUnit = new Map<string, UnitShare>()
  let any = false
  for (const list of lists) {
    if (!list) continue
    for (const s of list) {
      any = true
      const prev = byUnit.get(s.unit)
      if (!prev) {
        byUnit.set(s.unit, { ...s })
        continue
      }
      prev.volume += s.volume
      prev.costedVolume += s.costedVolume
      prev.spend = prev.spend === null && s.spend === null ? null : (prev.spend ?? 0) + (s.spend ?? 0)
    }
  }
  if (!any) return null
  return [...byUnit.values()].sort((a, b) => b.volume - a.volume)
}

export function scaleUnitShares(list: UnitShare[] | null, factor: number): UnitShare[] | null {
  if (!list) return null
  const round = (n: number) => Math.round(n * factor * 100) / 100
  return list.map((s) => ({
    unit: s.unit,
    volume: round(s.volume),
    spend: s.spend === null ? null : round(s.spend),
    costedVolume: round(s.costedVolume),
  }))
}
