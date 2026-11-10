import { PageHeader } from '@/components/page-header'
import { CompareView } from '@/components/compare-view'
import {
  getProductComparisons,
  type PriceRow,
  type ProductComparison,
} from '@/app/actions/comparisons'

// Offer fields the Compare view never reads. Dropping them, and pointing
// best/worst at the same offer objects instead of copies, keeps the payload
// sent to the browser small enough to hydrate quickly.
function slimOffer(o: PriceRow): PriceRow {
  return {
    ...o,
    category: null,
    application: null,
    subcategory: null,
    viscosity: null,
    brand: null,
    performanceSpec: null,
    region: null,
  }
}

function slim(comparisons: ProductComparison[]): ProductComparison[] {
  return comparisons.map((c) => {
    const offers = c.offers.map(slimOffer)
    const byId = new Map(offers.map((o) => [o.priceId, o]))
    return {
      ...c,
      offers,
      best: c.best ? (byId.get(c.best.priceId) ?? slimOffer(c.best)) : null,
      worst: c.worst ? (byId.get(c.worst.priceId) ?? slimOffer(c.worst)) : null,
    }
  })
}

export default async function ComparePage() {
  const comparisons = slim(await getProductComparisons())

  return (
    <>
      <PageHeader
        title="Compare Products"
        description="Side-by-side vendor pricing per product, ranked by potential savings. Landed cost includes shipping spread across the minimum order."
      />
      <CompareView comparisons={comparisons} />
    </>
  )
}
