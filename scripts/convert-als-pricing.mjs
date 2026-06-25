// One-time: apply per-package → per-unit price conversion to the already-staged
// (pending) ALS import, matching what the updated import route now does at stage
// time. Reuses lib/price-basis.ts so the behavior is identical. Dry-run unless
// --apply is passed.
import { Pool } from 'pg'
import {
  detectPriceBasis,
  toPerUnit,
  baseKind,
  baseUnitWord,
  PER_UNIT_CEILING,
} from '../lib/price-basis.ts'

const APPLY = process.argv.includes('--apply')
const IMPORT_ID = 10
const BULK_DECANT_RE = /\b(bulk|decant|dcnt)\b/i

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  const { rows } = await client.query(
    `select id, "productName", sku, unit, "unitPrice", "shippingCost",
            "deliveredPrice", "packSize", "baseUnit", "containerRaw",
            "reviewReason", "freightTerms"
     from import_rows where "importId" = $1 order by id`,
    [IMPORT_ID],
  )
  console.log(`import ${IMPORT_ID}: ${rows.length} pending rows`)

  const basis = detectPriceBasis(
    rows.map((r) => ({
      packSize: Number(r.packSize),
      baseUnit: r.baseUnit,
      unitPrice: r.unitPrice == null ? null : Number(r.unitPrice),
    })),
  )
  console.log(`detected price basis: ${basis}`)
  if (basis !== 'per-package') {
    console.log('nothing to convert; exiting')
    process.exit(0)
  }

  if (APPLY) await client.query('BEGIN')
  let converted = 0
  let flagged = 0
  for (const r of rows) {
    const containerText = `${r.productName} ${r.sku ?? ''} ${r.containerRaw ?? ''}`
    const isBulkDecant = BULK_DECANT_RE.test(containerText)
    const packGallons = Number(r.packSize)
    const word = baseUnitWord(r.baseUnit)
    const ceiling = PER_UNIT_CEILING[baseKind(r.baseUnit)]
    let reviewReason = r.reviewReason || null
    let unitPrice = r.unitPrice == null ? null : Number(r.unitPrice)
    let deliveredPrice =
      r.deliveredPrice == null ? null : Number(r.deliveredPrice)
    let shipping = r.shippingCost == null ? 0 : Number(r.shippingCost)

    const addNote = (n) => {
      reviewReason = reviewReason ? `${reviewReason} ${n}` : n
    }

    if (!isBulkDecant && packGallons <= 1) {
      addNote(
        `This file is priced per package but the container size couldn't be determined — the price shown may be a package total. Verify the pack size.`,
      )
      flagged++
    } else if (packGallons > 1) {
      const orig = unitPrice
      unitPrice = toPerUnit(unitPrice, packGallons)
      deliveredPrice = toPerUnit(deliveredPrice, packGallons)
      shipping = toPerUnit(shipping, packGallons) ?? 0
      if (orig != null && unitPrice != null) {
        addNote(
          `Converted to per-${word}: $${orig.toFixed(2)} ÷ ${packGallons.toFixed(2)} ${word} = $${unitPrice.toFixed(2)}/${word}.`,
        )
        converted++
      }
      if (unitPrice != null && unitPrice > ceiling) {
        addNote(
          `The converted per-${word} price looks high — verify the container size is correct.`,
        )
        flagged++
      }
    } else {
      // bulk/decant, packGallons == 1: already per-unit, no change
      continue
    }

    if (!APPLY) {
      console.log(
        `  ${(r.productName || '').slice(0, 36).padEnd(36)} ${String(r.unitPrice).padStart(9)} -> ${unitPrice == null ? 'n/a' : unitPrice.toFixed(2).padStart(8)}/${word}  [${r.packSize} ${r.baseUnit}]`,
      )
    } else {
      await client.query(
        `update import_rows
         set "unitPrice" = $1, "deliveredPrice" = $2, "shippingCost" = $3,
             "reviewReason" = $4, "needsReview" = $5
         where id = $6`,
        [
          unitPrice == null ? null : unitPrice.toFixed(2),
          deliveredPrice == null ? null : deliveredPrice.toFixed(2),
          shipping.toFixed(2),
          reviewReason,
          reviewReason !== null,
          r.id,
        ],
      )
    }
  }
  if (APPLY) await client.query('COMMIT')
  console.log(
    `${APPLY ? 'APPLIED' : 'DRY-RUN'} — converted: ${converted}, flagged: ${flagged}`,
  )
} catch (e) {
  if (APPLY) await client.query('ROLLBACK').catch(() => {})
  console.error('ERR', e.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
