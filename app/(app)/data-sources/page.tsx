import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/roles'
import { getSnowflakeSettings } from '@/app/actions/snowflake'
import { getSourceMapping } from '@/app/actions/snowflake-source'
import { getLocations } from '@/app/actions/locations'
import { PageHeader } from '@/components/page-header'
import { SnowflakeConnectionForm } from '@/components/snowflake-connection-form'
import { SnowflakeSourceMapping } from '@/components/snowflake-source-mapping'

export default async function DataSourcesPage() {
  const currentUser = await getCurrentUser()
  if (!currentUser) redirect('/sign-in')
  if (currentUser.role !== 'admin') redirect('/')

  const [settings, mapping, locations] = await Promise.all([
    getSnowflakeSettings(),
    getSourceMapping(),
    getLocations(),
  ])

  return (
    <>
      <PageHeader
        title="Data Sources"
        description="Connect external systems the app reads live purchasing data from."
      />
      <div className="flex flex-col gap-6 px-6 py-6">
        <SnowflakeConnectionForm settings={settings} />
        <SnowflakeSourceMapping
          mapping={mapping}
          locations={locations.map((l) => ({ id: l.id, name: l.name }))}
          connected={Boolean(settings)}
        />
      </div>
    </>
  )
}
