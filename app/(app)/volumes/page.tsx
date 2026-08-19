import { PageHeader } from '@/components/page-header'
import { VolumesView } from '@/components/volumes-view'
import { getVolumeImports } from '@/app/actions/volumes'
import { getLocations } from '@/app/actions/locations'

export default async function VolumesPage() {
  const [volumeImports, locations] = await Promise.all([
    getVolumeImports(),
    getLocations(),
  ])

  const rows = volumeImports.map((imp) => ({
    id: imp.id,
    fileName: imp.fileName,
    fileType: imp.fileType,
    blobPathname: imp.blobPathname,
    locationId: imp.locationId ?? null,
    locationName: imp.locationName ?? null,
    defaultPeriod: imp.defaultPeriod,
    status: imp.status,
    rowCount: imp.rowCount,
    createdAt: imp.createdAt,
  }))

  return (
    <>
      <PageHeader
        title="Purchase Volumes"
        description="Upload each location's purchasing history. We extract what you buy and what you paid with AI, then apply it as real annual volume and a savings baseline in your comparisons."
      />
      <VolumesView
        volumeImports={rows}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      />
    </>
  )
}
