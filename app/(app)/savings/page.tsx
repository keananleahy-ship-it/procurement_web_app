import { PageHeader } from '@/components/page-header'
import { SavingsView } from '@/components/savings-view'
import { getSavingsPlan } from '@/app/actions/comparisons'

export default async function SavingsPage() {
  const plan = await getSavingsPlan()

  return (
    <>
      <PageHeader
        title="Savings Opportunities"
        description="Where switching to the cheapest qualifying supplier saves money, which vendors win the most items, and which items are single-sourced."
      />
      <SavingsView plan={plan} />
    </>
  )
}
