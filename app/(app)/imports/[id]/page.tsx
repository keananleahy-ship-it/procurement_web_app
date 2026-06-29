import { notFound, redirect } from 'next/navigation'
import { PageHeader } from '@/components/page-header'
import { ImportReview } from '@/components/import-review'
import { getImportWithRows } from '@/app/actions/imports'
import { getLocations } from '@/app/actions/locations'

export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const importId = Number(id)
  if (!Number.isFinite(importId)) notFound()

  const data = await getImportWithRows(importId)
  if (!data) notFound()

  // Already-processed imports have nothing to review.
  if (data.import.status !== 'pending') redirect('/imports')

  const locations = await getLocations()
  const locationName = data.import.locationId
    ? (locations.find((l) => l.id === data.import.locationId)?.name ?? null)
    : null

  return (
    <>
      <PageHeader
        title="Review extracted prices"
        description="Check the AI-extracted line items, fix anything that looks off, then import. Nothing updates your pricing until you confirm."
      />
      <ImportReview
        meta={{
          id: data.import.id,
          fileName: data.import.fileName,
          locationName,
          effectiveDate: data.import.effectiveDate,
          status: data.import.status,
        }}
        rows={data.rows.map((r) => ({
          id: r.id,
          productName: r.productName,
          vendorName: r.vendorName,
          unitPrice: r.unitPrice,
          priceBasis: r.priceBasis,
          shippingCost: r.shippingCost,
          freightEstimated: r.freightEstimated,
          freightTerms: r.freightTerms,
          deliveredPrice: r.deliveredPrice,
          minOrderQty: r.minOrderQty,
          currency: r.currency,
          unit: r.unit,
          packSize: r.packSize,
          baseUnit: r.baseUnit,
          include: r.include,
        }))}
      />
    </>
  )
}
