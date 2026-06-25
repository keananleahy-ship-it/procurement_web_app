import { PageHeader } from '@/components/page-header'
import { TrendsView } from '@/components/trends-view'
import { getPriceTrends } from '@/app/actions/comparisons'

export default async function TrendsPage() {
  const { trends } = await getPriceTrends()

  return (
    <>
      <PageHeader
        title="Price Trends"
        description="How each vendor's price for an item moves over time, with the change since the previous quote."
      />
      <TrendsView trends={trends} />
    </>
  )
}
