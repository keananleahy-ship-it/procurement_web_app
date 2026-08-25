import { PageHeader } from '@/components/page-header'
import { SpecGapsView } from '@/components/spec-gaps-view'
import { getGapItems } from '@/app/actions/spec-gaps'

export default async function GapsPage() {
  const items = await getGapItems()

  return (
    <>
      <PageHeader
        title="Attribute Gaps"
        description="Fill the missing attributes that keep products out of spec comparison. Ranked so the products whose spec another vendor already sells come first."
      />
      <SpecGapsView items={items} />
    </>
  )
}
