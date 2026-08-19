import { PageHeader } from '@/components/page-header'
import { SavingsView } from '@/components/savings-view'
import { getAwSavingsAnalyses } from '@/app/actions/savings'

export default async function SavingsPage() {
  const result = await getAwSavingsAnalyses()

  return (
    <>
      <PageHeader
        title="Savings Opportunities"
        description="AW hydraulic fluid, analyzed three ways: price paid across locations, cheaper equivalent products, and lower-cost packaging. Each lens is sized by annual purchase volume."
      />
      <SavingsView result={result} />
    </>
  )
}
