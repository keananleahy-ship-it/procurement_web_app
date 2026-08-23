import { PageHeader } from '@/components/page-header'
import { VendorsView } from '@/components/vendors-view'
import { getVendors, getVendorNameVariants } from '@/app/actions/vendors'

export default async function VendorsPage() {
  const [vendors, variantGroups] = await Promise.all([
    getVendors(),
    getVendorNameVariants(),
  ])

  return (
    <>
      <PageHeader
        title="Vendors"
        description="The suppliers you source from and compare prices across."
      />
      <VendorsView
        vendors={vendors.map((v) => ({
          id: v.id,
          name: v.name,
          contactEmail: v.contactEmail,
          notes: v.notes,
        }))}
        variantGroups={variantGroups}
      />
    </>
  )
}
