import { PageHeader } from '@/components/page-header'
import { CompareView } from '@/components/compare-view'
import { getProductComparisons } from '@/app/actions/comparisons'

export default async function ComparePage() {
  const comparisons = await getProductComparisons()

  return (
    <>
      <PageHeader
        title="Compare Products"
        description="Side-by-side vendor pricing per product, ranked by potential savings. Landed cost includes shipping spread across the minimum order."
      />
      <CompareView comparisons={comparisons} />
    </>
  )
}
