import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/roles'
import { getUsers } from '@/app/actions/users'
import { listInvitations } from '@/app/actions/invitations'
import { PageHeader } from '@/components/page-header'
import { UsersManager } from '@/components/users-manager'
import { InvitationsManager } from '@/components/invitations-manager'

export default async function AdminPage() {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')
  // Viewers and uploaders never see user management.
  if (currentUser.role !== 'admin') redirect('/')

  const [users, invitations] = await Promise.all([getUsers(), listInvitations()])

  return (
    <>
      <PageHeader
        title="User Management"
        description="Invite people and assign roles to control who can view, upload, and administer the workspace."
      />
      <div className="flex flex-col gap-10 px-6 py-6">
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Invitations
            </h2>
            <p className="text-sm text-muted-foreground">
              Access is invite-only. Create a secure link to bring someone into
              the workspace with the role you choose.
            </p>
          </div>
          <InvitationsManager invitations={invitations} />
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Members</h2>
            <p className="text-sm text-muted-foreground">
              Change roles or remove access for existing members.
            </p>
          </div>
          <UsersManager users={users} currentUserId={currentUser.id} />
        </section>
      </div>
    </>
  )
}
