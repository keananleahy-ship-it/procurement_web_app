import { Download } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { buttonVariants } from '@/components/ui/button'
import { ProductsView } from '@/components/products-view'
import { requireUser } from '@/lib/roles'
import { buildProductList } from '@/lib/product-list'

export default async function ProductsPage() {
  await requireUser()
  const rows = await buildProductList()

  return (
    <>
      <PageHeader
        title="Products"
        description="Vendor-specific items you collect prices for. Their characteristics decide which products are compared against each other."
        action={
          <a
            href="/api/export/items"
            download
            className={buttonVariants({ variant: 'outline' })}
          >
            <Download aria-hidden="true" />
            Export item database
          </a>
        }
      />
      <ProductsView rows={rows} />
    </>
  )
}
