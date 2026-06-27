import { PageHeader } from '@/components/page-header'
import { OverviewView } from '@/components/overview-view'
import { RemovalRequestsAlert } from '@/components/removal-requests-alert'
import { SavingsAssistant } from '@/components/savings-assistant'
import {
  getDashboardStats,
  getLocationComparisons,
  getProductComparisons,
} from '@/app/actions/comparisons'
import { getPendingRemovalRequests } from '@/app/actions/removal-requests'

export default async function OverviewPage() {
  const [stats, comparisons, locationComparisons, removalRequests] =
    await Promise.all([
      getDashboardStats(),
      getProductComparisons(),
      getLocationComparisons(),
      getPendingRemovalRequests(),
    ])

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your sourcing snapshot — savings opportunities and cost by location."
      />
      <div className="flex flex-col gap-6 p-6 pb-0">
        <RemovalRequestsAlert requests={removalRequests} />
        <SavingsAssistant />
      </div>
      <OverviewView
        stats={stats}
        topComparisons={comparisons.slice(0, 6)}
        locationComparisons={locationComparisons}
      />
    </>
  )
}
