import { Suspense } from 'react'
import { PageHeader } from '@/components/page-header'
import { OpportunitiesView } from '@/components/opportunities-view'
import { TightnessControl } from '@/components/tightness-control'
import { buildOpportunities } from '@/lib/opportunities'
import { decodeTightness } from '@/lib/traits'

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>
}) {
  const { t } = await searchParams
  const data = await buildOpportunities(decodeTightness(t))

  return (
    <>
      <PageHeader
        title="Buying Opportunities"
        description="What each location actually paid, against every comparable offer from every supplier, at that location and across the network."
        action={
          <Suspense>
            <TightnessControl />
          </Suspense>
        }
      />
      <OpportunitiesView data={data} />
    </>
  )
}
