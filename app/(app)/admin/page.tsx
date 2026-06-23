import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/roles'
import { getUsers } from '@/app/actions/users'
import { PageHeader } from '@/components/page-header'
import { UsersManager } from '@/components/users-manager'

export default async function AdminPage() {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')
  // Viewers and uploaders never see user management.
  if (currentUser.role !== 'admin') redirect('/')

  const users = await getUsers()

  return (
    <>
      <PageHeader
        title="User Management"
        description="Assign roles to control who can view, upload, and administer the workspace."
      />
      <div className="px-6 py-6">
        <UsersManager users={users} currentUserId={currentUser.id} />
      </div>
    </>
  )
}
