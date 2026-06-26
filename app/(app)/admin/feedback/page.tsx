import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/roles'
import { getFeedback } from '@/app/actions/feedback'
import { PageHeader } from '@/components/page-header'
import { FeedbackManager } from '@/components/feedback-manager'

export default async function AdminFeedbackPage() {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')
  // Only admins triage feedback.
  if (currentUser.role !== 'admin') redirect('/')

  const items = await getFeedback()

  return (
    <>
      <PageHeader
        title="Feedback & Issue Reports"
        description="Review issues users flagged from the Compare tab — incorrect matches, misidentified containers, and more."
      />
      <div className="px-6 py-6">
        <FeedbackManager items={items} />
      </div>
    </>
  )
}
