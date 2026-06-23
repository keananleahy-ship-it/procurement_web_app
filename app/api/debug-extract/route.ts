import { NextResponse } from 'next/server'
import { extractPriceRows } from '@/lib/extract'

export const maxDuration = 120

// TEMPORARY debug-only route to validate the extraction pipeline end-to-end
// from inside the Next.js runtime (where AI Gateway credentials are injected).
export async function GET(req: Request) {
  const count = Number(new URL(req.url).searchParams.get('n') || '120')
  const lines = ['Vendor,SKU,Description,Unit,Unit Price,Freight Terms,Freight']
  for (let i = 1; i <= count; i++) {
    const delivered = i % 3 === 0
    lines.push(
      `Acme Industrial Supply,SKU-${1000 + i},Industrial Component ${i},box of 100,${(
        Math.random() * 90 +
        5
      ).toFixed(2)},${delivered ? 'Delivered' : 'FOB origin'},${
        delivered ? '' : `$${(Math.random() * 60 + 20).toFixed(0)} per order (min 5)`
      }`,
    )
  }
  const text = `# Sheet: Pricing\n${lines.join('\n')}`

  const start = Date.now()
  try {
    const result = await extractPriceRows({ kind: 'text', text })
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - start,
      inputRows: lines.length - 1,
      extractedRows: result.rows.length,
      defaultVendorName: result.defaultVendorName,
      withFreight: result.rows.filter((r) => Number(r.shippingCost) > 0).length,
      sample: result.rows.slice(0, 2),
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
