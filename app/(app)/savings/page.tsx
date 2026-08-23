import { PageHeader } from '@/components/page-header'
import { SavingsView } from '@/components/savings-view'
import { getSavingsAnalyses } from '@/app/actions/savings'

export default async function SavingsPage() {
  const result = await getSavingsAnalyses()

  return (
    <>
      <PageHeader
        title="Savings Opportunities"
        description="Every equivalent item, analyzed three ways: price paid across locations, cheaper equivalent products, and lower-cost packaging. Each lens is sized by annual purchase volume. Use the category selector to narrow the list."
      />
      <SavingsView result={result} />
    </>
  )
}
