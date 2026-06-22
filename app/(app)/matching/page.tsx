import { PageHeader } from '@/components/page-header'
import { MatchingView } from '@/components/matching-view'
import { getCanonicalItems, getMatchRows } from '@/app/actions/canonical'

export default async function MatchingPage() {
  const [rows, items] = await Promise.all([
    getMatchRows(),
    getCanonicalItems(),
  ])

  return (
    <>
      <PageHeader
        title="Match Verification"
        description="Review fuzzy-matched suggestions and confirm or reject each one before it's used in comparisons."
      />
      <MatchingView
        rows={rows}
        canonicalItems={items.map((i) => ({ id: i.id, name: i.name }))}
      />
    </>
  )
}
