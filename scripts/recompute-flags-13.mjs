// One-off: recompute needsReview/reviewReason for import 13 (Shell) under the
// new class-aware flagging rules, without re-extracting. The stored sizes and
// unit classes are already correct; only the stale flags need clearing.
//
//  - Drop the obsolete "Unit X differs from the file's usual Y" token-mismatch
//    sentence entirely (mixed catalogs legitimately use many units).
//  - For per-piece ('each') items, drop sizing-ambiguity sentences (excluded
//    from comparison, so pack size is irrelevant).
//  - Drop the ambiguity sentence when our deterministic parser confidently
//    resolves the container notation (tote or "N/M unit" / "N*M unit" pack),
//    overriding the AI extractor's stale ambiguity flag.
//
// Usage: node --env-file=/vercel/share/.env.project scripts/recompute-flags-13.mjs [--apply]
import { Pool } from 'pg'
import {
  resolveCasePack,
  resolveNumberedTote,
} from '../lib/container-infer.ts'
import { buildVendorProfile } from '../lib/vendor-profile.ts'

const APPLY = process.argv.includes('--apply')
const IMPORT_ID = 13
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const profile = buildVendorProfile([]) // seed defaults (Shell has no saved tokens yet)

const TOKEN_MISMATCH_RE = /Unit\s+"[^"]*"\s+differs from the file's usual[^.]*\.\s*/g
const AMBIGUOUS_RE = /Container size(?:\s+"[^"]*")? could not be confidently parsed[^.]*\.\s*/g
const PKG_SIZE_RE = /This file is priced per package but the container size couldn't be determined[^.]*\.\s*/g
const BULK_DECANT_RE = /\b(bulk|decant|dcnt)\b/i

async function main() {
  const { rows } = await pool.query(
    `select id, "productName", "sku", "containerRaw", "unitClass",
            "reviewReason", "needsReview"
       from import_rows where "importId" = $1`,
    [IMPORT_ID],
  )

  let cleared = 0
  let trimmed = 0
  const updates = []
  for (const r of rows) {
    let reason = r.reviewReason ?? ''
    if (!reason) continue
    const before = reason.trim()

    const containerText = `${r.productName} ${r.sku ?? ''} ${r.containerRaw ?? ''}`
    const isBulkDecant = BULK_DECANT_RE.test(containerText)
    const resolvedConfidently =
      !isBulkDecant &&
      (!!resolveNumberedTote(containerText) ||
        !!resolveCasePack(containerText, profile))

    // Always drop the token-mismatch sentence.
    reason = reason.replace(TOKEN_MISMATCH_RE, '')
    // Drop sizing-ambiguity sentences for per-piece items or confident parses.
    if (r.unitClass === 'each' || resolvedConfidently) {
      reason = reason.replace(AMBIGUOUS_RE, '').replace(PKG_SIZE_RE, '')
    }
    reason = reason.trim()
    if (reason === before) continue
    const needsReview = reason.length > 0
    if (!needsReview) cleared++
    else trimmed++
    updates.push({ id: r.id, reason: reason || null, needsReview })
  }

  const flaggedBefore = rows.filter((r) => r.needsReview).length
  const stillFlagged = rows.filter(
    (r) => r.needsReview && !updates.find((u) => u.id === r.id && !u.needsReview),
  ).length
  console.log(`import ${IMPORT_ID}: ${rows.length} rows, ${flaggedBefore} flagged before`)
  console.log(`  rows fully cleared this pass: ${cleared}`)
  console.log(`  rows reason-trimmed (still flagged): ${trimmed}`)
  console.log(`  flagged after: ${stillFlagged}`)

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to write)')
    await pool.end()
    return
  }
  for (const u of updates) {
    await pool.query(
      `update import_rows set "reviewReason" = $2, "needsReview" = $3 where id = $1`,
      [u.id, u.reason, u.needsReview],
    )
  }
  console.log(`\nAPPLIED ${updates.length} updates.`)
  await pool.end()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
