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
        description="Review name-similarity and AI-suggested matches, then confirm or reject each one before it's used in comparisons."
      />
      <MatchingView
        rows={rows}
        canonicalItems={items.map((i) => ({ id: i.id, name: i.name }))}
      />
    </>
  )
}
