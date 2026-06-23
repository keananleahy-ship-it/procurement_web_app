import * as XLSX from 'xlsx'
import { extractPriceRows } from '../lib/extract.ts'

// Build a realistic ~540-row vendor price list with mixed freight scenarios.
const vendors = ['Acme Industrial Supply']
const units = ['box of 100', 'case of 24', '5 L jug', 'each', 'pallet']
const terms = ['FOB origin', 'Delivered', 'FOB', 'Delivered (freight incl.)']
const rows = [['Vendor', 'SKU', 'Product Description', 'Unit', 'Unit Price', 'Freight Terms', 'Freight']]

for (let i = 1; i <= 540; i++) {
  const unit = units[i % units.length]
  const term = terms[i % terms.length]
  const isDelivered = term.toLowerCase().includes('delivered')
  const price = (Math.random() * 90 + 5).toFixed(2)
  let freight = ''
  if (!isDelivered) {
    // Mix per-order and per-unit freight phrasing
    freight = i % 2 === 0 ? `$${(Math.random() * 60 + 20).toFixed(0)} per order (min 5)` : `$${(Math.random() * 2).toFixed(2)}/unit`
  }
  rows.push([
    vendors[0],
    `SKU-${1000 + i}`,
    `Industrial Component ${i} - grade ${String.fromCharCode(65 + (i % 5))}`,
    unit,
    price,
    term,
    freight,
  ])
}

// stray cell far out to test trimming
rows[700] = []
const ws = XLSX.utils.aoa_to_sheet(rows)
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'Pricing')

// Mirror the route's workbookToText conversion path via sheet_to_json
const allLines = []
const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '', raw: false })
const lines = []
for (const row of sheetRows) {
  let end = row.length
  while (end > 0 && String(row[end - 1] ?? '').trim() === '') end--
  if (end === 0) continue
  const cells = row.slice(0, end).map((c) => {
    const s = String(c ?? '').trim()
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  })
  lines.push(cells.join(','))
}
const text = `# Sheet: Pricing\n${lines.join('\n')}`

console.log('[v0] input rows:', rows.length - 1, 'text chars:', text.length)
const start = Date.now()
const result = await extractPriceRows({ kind: 'text', text })
const elapsed = ((Date.now() - start) / 1000).toFixed(1)
console.log('[v0] elapsed:', elapsed + 's')
console.log('[v0] defaultVendorName:', result.defaultVendorName)
console.log('[v0] rows extracted:', result.rows.length)
const withFreight = result.rows.filter((r) => Number(r.shippingCost) > 0).length
console.log('[v0] rows with freight > 0:', withFreight)
console.log('[v0] sample:', JSON.stringify(result.rows.slice(0, 3), null, 2))
