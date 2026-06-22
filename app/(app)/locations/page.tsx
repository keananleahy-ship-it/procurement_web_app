import { PageHeader } from '@/components/page-header'
import { LocationsView } from '@/components/locations-view'
import { getLocations } from '@/app/actions/locations'

export default async function LocationsPage() {
  const locations = await getLocations()

  return (
    <>
      <PageHeader
        title="Locations"
        description="Sites you buy for — compare acquisition costs across them."
      />
      <LocationsView
        locations={locations.map((l) => ({
          id: l.id,
          name: l.name,
          region: l.region,
        }))}
      />
    </>
  )
}
