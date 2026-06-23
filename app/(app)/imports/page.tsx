import { PageHeader } from '@/components/page-header'
import { ImportsView } from '@/components/imports-view'
import { getImports } from '@/app/actions/imports'
import { getLocations } from '@/app/actions/locations'

export default async function ImportsPage() {
  const [imports, locations] = await Promise.all([
    getImports(),
    getLocations(),
  ])

  const locationMap = new Map(locations.map((l) => [l.id, l.name]))

  const rows = imports.map((imp) => ({
    id: imp.id,
    fileName: imp.fileName,
    fileType: imp.fileType,
    blobPathname: imp.blobPathname,
    locationName: imp.locationId
      ? (locationMap.get(imp.locationId) ?? null)
      : null,
    effectiveDate: imp.effectiveDate,
    status: imp.status,
    rowCount: imp.rowCount,
    createdAt: imp.createdAt,
  }))

  return (
    <>
      <PageHeader
        title="Data Imports"
        description="Upload XLS or PDF price lists from each location. We extract the line items with AI, then you review before importing."
      />
      <ImportsView
        imports={rows}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      />
    </>
  )
}
