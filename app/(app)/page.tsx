import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/page-header'
import { OverviewView } from '@/components/overview-view'
import { SavingsAssistant } from '@/components/savings-assistant'
import {
  getDashboardStats,
  getLocationComparisons,
  getProductComparisons,
} from '@/app/actions/comparisons'
import { getCurrentUser } from '@/lib/roles'

export default async function OverviewPage() {
  // Guard before fetching: the layout redirects unauthenticated users, but the
  // page renders concurrently, so bail out here too to avoid throwing during render.
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')

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
      <div className="flex flex-col gap-6 p-6 pb-0">
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
