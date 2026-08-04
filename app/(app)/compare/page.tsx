import { PageHeader } from '@/components/page-header'
import { CompareView } from '@/components/compare-view'
import { getProductComparisons } from '@/app/actions/comparisons'
import { getGroupTree, getGroupMemberships } from '@/app/actions/groups'

export default async function ComparePage() {
  const [comparisons, groupTree, canonicalMemberships, productMemberships] =
    await Promise.all([
      getProductComparisons(),
      getGroupTree(),
      getGroupMemberships('canonical'),
      getGroupMemberships('product'),
    ])

  return (
    <>
      <PageHeader
        title="Compare Products"
        description="Side-by-side vendor pricing per product, ranked by potential savings. Landed cost includes shipping spread across the minimum order."
      />
      <CompareView
        comparisons={comparisons}
        groupTree={groupTree}
        canonicalMemberships={canonicalMemberships}
        productMemberships={productMemberships}
      />
    </>
  )
}
