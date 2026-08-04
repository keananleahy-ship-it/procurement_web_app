import { PageHeader } from '@/components/page-header'
import { ProductsView } from '@/components/products-view'
import { getProducts } from '@/app/actions/products'
import { getMatchRows, getCanonicalItems } from '@/app/actions/canonical'

export default async function ProductsPage() {
  const [products, matchRows, canonicalItems] = await Promise.all([
    getProducts(),
    getMatchRows(),
    getCanonicalItems(),
  ])

  const matchByProduct = new Map(matchRows.map((m) => [m.productId, m]))

  return (
    <>
      <PageHeader
        title="Products"
        description="Vendor-specific items you collect prices for. Match them to canonical items to compare across vendors."
      />
      <ProductsView
        canonicalItems={canonicalItems.map((c) => ({
          id: c.id,
          name: c.name,
        }))}
        products={products.map((p) => {
          const m = matchByProduct.get(p.id)
          return {
            id: p.id,
            name: p.name,
            brand: p.brand,
            category: p.category,
            subcategory: p.subcategory,
            viscosity: p.viscosity,
            packageType: p.packageType,
            supplier: p.supplier,
            sku: p.sku,
            unit: p.unit,
            matchStatus: m?.matchStatus ?? 'unmatched',
            canonicalItemId: m?.canonicalItemId ?? null,
            canonicalItemName:
              m?.matchStatus === 'confirmed' ? m.canonicalItemName : null,
          }
        })}
      />
    </>
  )
}
