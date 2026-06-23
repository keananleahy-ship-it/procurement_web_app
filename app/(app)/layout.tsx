import { redirect } from 'next/navigation'
import { AppSidebar } from '@/components/app-sidebar'
import { RoleProvider } from '@/components/role-provider'
import { getCurrentUser } from '@/lib/roles'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')

  return (
    <RoleProvider role={currentUser.role}>
      <div className="flex min-h-svh bg-background">
        <AppSidebar
          userName={currentUser.name || currentUser.email}
          role={currentUser.role}
        />
        <div className="flex-1 overflow-x-hidden">{children}</div>
      </div>
    </RoleProvider>
  )
}
