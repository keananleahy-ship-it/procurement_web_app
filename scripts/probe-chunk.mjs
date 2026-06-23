import { generateText, Output } from 'ai'
import * as z from 'zod'

const schema = z.object({
  defaultVendorName: z.string().nullable(),
  rows: z.array(
    z.object({
      productName: z.string(),
      unitPrice: z.number().nullable(),
      freightTerms: z.enum(['fob', 'delivered', 'both']).nullable(),
    }),
  ),
})

const lines = []
for (let i = 1; i <= 60; i++) {
  lines.push(`Fastener item ${i},SKU-${1000 + i},box of 100,box,${(i + 5).toFixed(2)},FOB,$50 per order,5`)
}
const text = 'Product,SKU,Pack,Unit,Unit Price,Freight Terms,Freight,Min Qty\n' + lines.join('\n')

const start = Date.now()
try {
  const { output } = await generateText({
    model: 'google/gemini-2.5-flash',
    system: 'Extract priced line items from this vendor price list section.',
    output: Output.object({ schema }),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    maxOutputTokens: 24000,
    maxRetries: 2,
  })
  console.log('[probe] OK in', ((Date.now() - start) / 1000).toFixed(1), 's rows:', output.rows.length)
} catch (e) {
  console.log('[probe] FAILED in', ((Date.now() - start) / 1000).toFixed(1), 's')
  console.log('[probe] name:', e?.name)
  console.log('[probe] message:', e?.message)
  console.log('[probe] cause:', JSON.stringify(e?.cause, null, 2)?.slice(0, 800))
}
