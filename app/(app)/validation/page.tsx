import { PageHeader } from '@/components/page-header'
import { ValidationView } from '@/components/validation-view'
import {
  getAccessibleLocations,
  getValidationRecords,
} from '@/app/actions/validation'

export default async function ValidationPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>
}) {
  const { location } = await searchParams
  const locations = await getAccessibleLocations()

  // Resolve the active location: the one in the URL if the user may access it,
  // otherwise the first accessible location. Undefined when none are assigned.
  const requested = location ? Number(location) : NaN
  const active =
    locations.find((l) => l.id === requested) ?? locations[0] ?? null

  const data = active
    ? await getValidationRecords(active.id)
    : { records: [], progress: { total: 0, validated: 0, needsAttention: 0 } }

  return (
    <>
      <PageHeader
        title="Catalog Validation"
        description="Read across each purchase record — vendor code, description, category, application, formulation, viscosity, and packaging — correct anything wrong, and sign off. Attribute fixes apply to the product everywhere; the record ID stays tied to your site."
      />
      <ValidationView
        locations={locations}
        activeLocationId={active?.id ?? null}
        records={data.records}
        progress={data.progress}
      />
    </>
  )
}
