import { redirect } from 'next/navigation'
import { AppSidebar } from '@/components/app-sidebar'
import { RoleProvider } from '@/components/role-provider'
import { getCurrentUser } from '@/lib/roles'
import { getOpenFeedbackCount } from '@/app/actions/feedback'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')

  // Only admins see the feedback queue, so only fetch the badge count for them.
  const openFeedbackCount =
    currentUser.role === 'admin' ? await getOpenFeedbackCount() : 0

  return (
    <RoleProvider role={currentUser.role}>
      <div className="flex min-h-svh bg-background">
        <AppSidebar
          userName={currentUser.name || currentUser.email}
          role={currentUser.role}
          openFeedbackCount={openFeedbackCount}
        />
        <div className="flex-1 overflow-x-hidden">{children}</div>
      </div>
    </RoleProvider>
  )
}
