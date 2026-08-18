import { notFound, redirect } from 'next/navigation'
import { PageHeader } from '@/components/page-header'
import { VolumeImportReview } from '@/components/volume-import-review'
import {
  getVolumeImportWithRows,
  getMatchTargets,
} from '@/app/actions/volumes'

export default async function VolumeReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const volumeImportId = Number(id)
  if (!Number.isFinite(volumeImportId)) notFound()

  const data = await getVolumeImportWithRows(volumeImportId)
  if (!data) notFound()

  // Already-processed uploads have nothing to review.
  if (data.import.status !== 'pending') redirect('/volumes')

  const targets = await getMatchTargets()

  return (
    <>
      <PageHeader
        title="Review purchase volumes"
        description="Check the extracted quantities and costs, match each item to a canonical item or product, then apply. Nothing changes your comparisons until you confirm."
      />
      <VolumeImportReview
        meta={{
          id: data.import.id,
          fileName: data.import.fileName,
          locationName: data.location?.name ?? null,
          defaultPeriod: data.import.defaultPeriod,
        }}
        rows={data.rows.map((r) => ({
          id: r.id,
          itemName: r.itemName,
          sku: r.sku,
          annualVolume: r.annualVolume,
          baseUnit: r.baseUnit,
          baselineUnitCost: r.baselineUnitCost,
          period: r.period,
          canonicalItemId: r.canonicalItemId,
          productId: r.productId,
          matchName: r.matchName,
          matchStatus: r.matchStatus,
          include: r.include,
        }))}
        canonicalItems={targets.canonicalItems}
        products={targets.products}
      />
    </>
  )
}
