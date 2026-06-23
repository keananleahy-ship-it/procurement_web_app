import { PageHeader } from '@/components/page-header'
import { CanonicalView } from '@/components/canonical-view'
import { getCanonicalItems } from '@/app/actions/canonical'
import { getMatchRows } from '@/app/actions/canonical'

export default async function CanonicalPage() {
  const [items, rows] = await Promise.all([
    getCanonicalItems(),
    getMatchRows(),
  ])

  const matchedCounts = new Map<number, number>()
  for (const r of rows) {
    if (r.matchStatus === 'confirmed' && r.canonicalItemId !== null) {
      matchedCounts.set(
        r.canonicalItemId,
        (matchedCounts.get(r.canonicalItemId) ?? 0) + 1,
      )
    }
  }

  return (
    <>
      <PageHeader
        title="Canonical Items"
        description="Master item definitions. Vendor products are matched to these so similar offerings compare as one."
      />
      <CanonicalView
        items={items.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          unit: i.unit,
          baseUnit: i.baseUnit,
          matchedCount: matchedCounts.get(i.id) ?? 0,
        }))}
      />
    </>
  )
}
