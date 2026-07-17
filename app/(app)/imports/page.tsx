import { PageHeader } from '@/components/page-header'
import { ImportsView } from '@/components/imports-view'
import { getImports } from '@/app/actions/imports'
import { getLocations } from '@/app/actions/locations'
import { getVendors } from '@/app/actions/vendors'

export default async function ImportsPage() {
  const [imports, locations, vendors] = await Promise.all([
    getImports(),
    getLocations(),
    getVendors(),
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
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
      />
    </>
  )
}
