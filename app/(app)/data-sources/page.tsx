import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/roles'
import { getSnowflakeSettings } from '@/app/actions/snowflake'
import { PageHeader } from '@/components/page-header'
import { SnowflakeConnectionForm } from '@/components/snowflake-connection-form'

export default async function DataSourcesPage() {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')
  if (currentUser.role !== 'admin') redirect('/')

  const settings = await getSnowflakeSettings()

  return (
    <>
      <PageHeader
        title="Data Sources"
        description="Connect external systems the app reads live purchasing data from."
      />
      <div className="px-6 py-6">
        <SnowflakeConnectionForm settings={settings} />
      </div>
    </>
  )
}
