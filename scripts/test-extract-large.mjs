import * as XLSX from 'xlsx'
import { extractPriceRows } from '../lib/extract.ts'

// Build a realistic ~540-row vendor price list.
const cats = ['Fasteners', 'Lubricants', 'Hoses', 'Filters', 'Valves', 'Seals']
const units = ['box', 'jug', 'case', 'each', 'drum']
const header = [
  'Product',
  'SKU',
  'Category',
  'Pack',
  'Unit',
  'Unit Price',
  'Freight Terms',
  'Freight',
  'Min Qty',
]
const aoa = [
  ['Acme Industrial Supply — 2026 Price List'],
  [],
  header,
]

for (let i = 1; i <= 540; i++) {
  const cat = cats[i % cats.length]
  const unit = units[i % units.length]
  const pack = [1, 5, 24, 100, 200][i % 5]
  const price = (Math.random() * 90 + 5).toFixed(2)
  const fob = i % 3 === 0
  aoa.push([
    `${cat} item ${i}`,
    `SKU-${1000 + i}`,
    cat,
    `${unit} of ${pack}`,
    unit,
    price,
    fob ? 'FOB' : 'Delivered',
    fob ? `$${(pack * 0.5).toFixed(2)} per order` : '',
    [1, 5, 10][i % 3],
  ])
}

// Add a stray faraway cell to confirm the trimming logic.
aoa[700] = []
aoa[700][50] = 'stray note'

const ws = XLSX.utils.aoa_to_sheet(aoa)
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'Prices')
const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

// Mirror the route's workbookToText (compact).
function workbookToText(wb) {
  const parts = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: false })
    const lines = []
    for (const row of rows) {
      let end = row.length
      while (end > 0 && String(row[end - 1] ?? '').trim() === '') end--
      if (end === 0) continue
      lines.push(row.slice(0, end).map((c) => {
        const s = String(c ?? '').trim()
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(','))
    }
    if (lines.length) parts.push(`# Sheet: ${name}\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

const wb2 = XLSX.read(buffer, { type: 'buffer' })
const text = workbookToText(wb2)
console.log('[test] text chars:', text.length, 'lines:', text.split('\n').length)

const start = Date.now()
const result = await extractPriceRows({ kind: 'text', text })
console.log('[test] elapsed sec:', ((Date.now() - start) / 1000).toFixed(1))
console.log('[test] defaultVendorName:', result.defaultVendorName)
console.log('[test] rows extracted:', result.rows.length)
console.log('[test] sample first:', JSON.stringify(result.rows[0]))
console.log('[test] sample last:', JSON.stringify(result.rows[result.rows.length - 1]))
const withFreight = result.rows.filter((r) => r.shippingCost && r.shippingCost > 0).length
console.log('[test] rows with per-unit freight > 0:', withFreight)
