import { Download } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { buttonVariants } from '@/components/ui/button'
import { ProductsView } from '@/components/products-view'
import { getProducts } from '@/app/actions/products'

export default async function ProductsPage() {
  const products = await getProducts()

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
      <ProductsView
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          brand: p.brand,
          category: p.category,
          application: p.application,
          subcategory: p.subcategory,
          viscosity: p.viscosity,
          packageType: p.packageType,
          performanceSpec: p.performanceSpec,
          supplier: p.supplier,
          sku: p.sku,
          unit: p.unit,
        }))}
      />
    </>
  )
}
