import { PageHeader } from '@/components/page-header'
import { PricesView } from '@/components/prices-view'
import { getPrices } from '@/app/actions/prices'
import { getProducts } from '@/app/actions/products'
import { getVendors } from '@/app/actions/vendors'
import { getLocations } from '@/app/actions/locations'

export default async function PricesPage() {
  const [prices, products, vendors, locations] = await Promise.all([
    getPrices(),
    getProducts(),
    getVendors(),
    getLocations(),
  ])

  const productMap = new Map(products.map((p) => [p.id, p.name]))
  const vendorMap = new Map(vendors.map((v) => [v.id, v.name]))
  const locationMap = new Map(locations.map((l) => [l.id, l.name]))

  const rows = prices.map((p) => ({
    id: p.id,
    productName: productMap.get(p.productId) ?? 'Unknown product',
    vendorName: vendorMap.get(p.vendorId) ?? 'Unknown vendor',
    locationName: p.locationId ? (locationMap.get(p.locationId) ?? null) : null,
    unitPrice: Number(p.unitPrice),
    shippingCost: Number(p.shippingCost),
    freightTerms: p.freightTerms,
    deliveredPrice:
      p.deliveredPrice !== null ? Number(p.deliveredPrice) : null,
    minOrderQty: p.minOrderQty,
    currency: p.currency,
  }))

  return (
    <>
      <PageHeader
        title="Price Entries"
        description="Record what each vendor charges for a product at a given location."
      />
      <PricesView
        prices={rows}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      />
    </>
  )
}
