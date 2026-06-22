import { PageHeader } from '@/components/page-header'
import { ProductsView } from '@/components/products-view'
import { getProducts } from '@/app/actions/products'
import { getMatchRows } from '@/app/actions/canonical'

export default async function ProductsPage() {
  const [products, matchRows] = await Promise.all([
    getProducts(),
    getMatchRows(),
  ])

  const matchByProduct = new Map(matchRows.map((m) => [m.productId, m]))

  return (
    <>
      <PageHeader
        title="Products"
        description="Vendor-specific items you collect prices for. Match them to canonical items to compare across vendors."
      />
      <ProductsView
        products={products.map((p) => {
          const m = matchByProduct.get(p.id)
          return {
            id: p.id,
            name: p.name,
            category: p.category,
            sku: p.sku,
            unit: p.unit,
            matchStatus: m?.matchStatus ?? 'unmatched',
            canonicalItemName:
              m?.matchStatus === 'confirmed' ? m.canonicalItemName : null,
          }
        })}
      />
    </>
  )
}
