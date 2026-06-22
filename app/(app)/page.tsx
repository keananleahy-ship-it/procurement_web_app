import { PageHeader } from '@/components/page-header'
import { OverviewView } from '@/components/overview-view'
import {
  getDashboardStats,
  getLocationComparisons,
  getProductComparisons,
} from '@/app/actions/comparisons'

export default async function OverviewPage() {
  const [stats, comparisons, locationComparisons] = await Promise.all([
    getDashboardStats(),
    getProductComparisons(),
    getLocationComparisons(),
  ])

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your sourcing snapshot — savings opportunities and cost by location."
      />
      <OverviewView
        stats={stats}
        topComparisons={comparisons.slice(0, 6)}
        locationComparisons={locationComparisons}
      />
    </>
  )
}
