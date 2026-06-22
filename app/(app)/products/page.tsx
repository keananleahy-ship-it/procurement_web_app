import { PageHeader } from '@/components/page-header'
import { ProductsView } from '@/components/products-view'
import { getProducts } from '@/app/actions/products'

export default async function ProductsPage() {
  const products = await getProducts()

  return (
    <>
      <PageHeader
        title="Products"
        description="The items you purchase. Group similar offerings under one product to compare vendors."
      />
      <ProductsView
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          sku: p.sku,
          unit: p.unit,
        }))}
      />
    </>
  )
}
