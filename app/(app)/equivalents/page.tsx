import { PageHeader } from '@/components/page-header'
import { EquivalentsView } from '@/components/equivalents-view'
import { getSpecItems, getCanonicalSpreads } from '@/app/actions/equivalents'

export default async function EquivalentsPage() {
  const [items, spreads] = await Promise.all([
    getSpecItems(),
    getCanonicalSpreads(),
  ])

  return (
    <>
      <PageHeader
        title="Spec Equivalents"
        description="Find products meeting the same specification from a different supplier. Grouping is derived from catalog attributes, not from matching."
      />
      <EquivalentsView items={items} spreads={spreads} />
    </>
  )
}
