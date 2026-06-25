import { PageHeader } from '@/components/page-header'
import { LocationCompareView } from '@/components/location-compare-view'
import { getLocationMatrix } from '@/app/actions/comparisons'

export default async function ByLocationPage() {
  const { locations, items } = await getLocationMatrix()

  return (
    <>
      <PageHeader
        title="Compare by Location"
        description="The best price for each item at every location, with cross-location spread to spot where one site pays more than another."
      />
      <LocationCompareView locations={locations} items={items} />
    </>
  )
}
