import { NextResponse } from 'next/server'
import { getAwSavingsAnalyses } from '@/app/actions/savings'

export const dynamic = 'force-dynamic'

export async function GET() {
  const summarize = (
    r: Awaited<ReturnType<typeof getAwSavingsAnalyses>>,
  ) => {
    const iso46 = r.items.find((a) => /ISO 46/i.test(a.name))
    return {
      basis: r.packagingBasis,
      total: r.items.reduce((s, a) => s + (a.byPackaging.opportunity ?? 0), 0),
      iso46: iso46
        ? {
            opp: iso46.byPackaging.opportunity,
            rows: iso46.byPackaging.breakdown.map((b) => ({
              from: b.familyLabel,
              to: b.targetFamilyLabel,
              here: b.currentBestPerUnit,
              tgt: b.targetPerUnit,
              opp: Math.round(b.opportunity),
              switch: b.targetLabel,
              products: b.products.map((p) => ({
                name: p.productName.slice(0, 26),
                to: p.targetFamilyLabel,
                here: p.currentBestPerUnit,
                tgt: p.targetPerUnit,
                opp: Math.round(p.opportunity),
              })),
            })),
          }
        : null,
    }
  }
  const [equiv, sameProduct] = await Promise.all([
    getAwSavingsAnalyses({ packagingBasis: 'equivalent' }),
    getAwSavingsAnalyses({ packagingBasis: 'same-product' }),
  ])
  return NextResponse.json({
    equivalent: summarize(equiv),
    sameProduct: summarize(sameProduct),
  })
}
