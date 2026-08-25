import { PageHeader } from '@/components/page-header'
import { SpecGapsView } from '@/components/spec-gaps-view'
import { getGapItems } from '@/app/actions/spec-gaps'

export default async function GapsPage() {
  // Role gating lives in the view via useCanEdit()/RoleProvider, matching the
  // other 11 views, so nothing role-related is passed down from here.
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
