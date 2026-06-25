'use server'

import { db } from '@/lib/db'
import { vendors, vendorTokenMappings } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { and, asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  buildVendorProfile,
  inferLearnableTokens,
  type TokenKind,
  type VendorTokenRow,
} from '@/lib/vendor-profile'

const VALID_KINDS: TokenKind[] = [
  'unit',
  'separator',
  'container',
  'unit_class',
]

// Load a vendor's stored token mappings (manual + learned). Seed tokens are not
// stored; they're merged in by buildVendorProfile at parse time.
export async function getVendorTokens(vendorId: number) {
  await requireUser()
  return db
    .select()
    .from(vendorTokenMappings)
    .where(eq(vendorTokenMappings.vendorId, vendorId))
    .orderBy(asc(vendorTokenMappings.token))
}

// Upsert one (token, kind) mapping for a vendor. A manual edit always wins and
// is marked source='manual'. Used by the dictionary editor UI.
export async function upsertVendorToken(input: {
  vendorId: number
  token: string
  kind: TokenKind
  value: string
}) {
  const { id: userId } = await requireEditor()
  const token = input.token.trim().toLowerCase()
  const value = input.value.trim()
  if (!token || !value) throw new Error('Token and value are required')
  if (!VALID_KINDS.includes(input.kind)) throw new Error('Invalid token kind')

  const [existing] = await db
    .select({ id: vendorTokenMappings.id })
    .from(vendorTokenMappings)
    .where(
      and(
        eq(vendorTokenMappings.vendorId, input.vendorId),
        eq(vendorTokenMappings.token, token),
        eq(vendorTokenMappings.kind, input.kind),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(vendorTokenMappings)
      .set({ value, source: 'manual', updatedAt: new Date() })
      .where(eq(vendorTokenMappings.id, existing.id))
  } else {
    await db.insert(vendorTokenMappings).values({
      userId,
      vendorId: input.vendorId,
      token,
      kind: input.kind,
      value,
      source: 'manual',
    })
  }
  revalidatePath('/vendors')
}

export async function deleteVendorToken(id: number) {
  await requireEditor()
  await db.delete(vendorTokenMappings).where(eq(vendorTokenMappings.id, id))
  revalidatePath('/vendors')
}

// Auto-learn from a reviewer correction: given the raw container text and the
// size the reviewer confirmed, infer and persist any new mappings for this
// vendor. Never overrides a manual mapping; bumps confirmations when the same
// learned mapping recurs. Best-effort — failures must not break the review flow.
export async function learnFromCorrection(input: {
  vendorId: number | null
  containerRaw: string | null
  packSize: number
  baseUnit: string | null
}) {
  if (!input.vendorId || !input.containerRaw) return
  let userId: string
  try {
    ;({ id: userId } = await requireEditor())
  } catch {
    return
  }

  const existingRows = (
    await db
      .select({
        token: vendorTokenMappings.token,
        kind: vendorTokenMappings.kind,
        value: vendorTokenMappings.value,
        source: vendorTokenMappings.source,
      })
      .from(vendorTokenMappings)
      .where(eq(vendorTokenMappings.vendorId, input.vendorId))
  ).map((r) => ({
    token: r.token,
    kind: r.kind as VendorTokenRow['kind'],
    value: r.value,
    source: r.source as VendorTokenRow['source'],
  }))

  const profile = buildVendorProfile(existingRows)
  const learned = inferLearnableTokens(
    input.containerRaw,
    { packSize: input.packSize, baseUnit: input.baseUnit },
    profile,
  )
  if (learned.length === 0) return

  for (const m of learned) {
    const [existing] = await db
      .select({
        id: vendorTokenMappings.id,
        source: vendorTokenMappings.source,
        confirmations: vendorTokenMappings.confirmations,
      })
      .from(vendorTokenMappings)
      .where(
        and(
          eq(vendorTokenMappings.vendorId, input.vendorId),
          eq(vendorTokenMappings.token, m.token),
          eq(vendorTokenMappings.kind, m.kind),
        ),
      )
      .limit(1)

    if (!existing) {
      await db.insert(vendorTokenMappings).values({
        userId,
        vendorId: input.vendorId,
        token: m.token,
        kind: m.kind,
        value: m.value,
        source: 'learned',
      })
    } else if (existing.source !== 'manual') {
      // Reinforce a prior learned mapping; never clobber a manual one.
      await db
        .update(vendorTokenMappings)
        .set({
          value: m.value,
          confirmations: existing.confirmations + 1,
          updatedAt: new Date(),
        })
        .where(eq(vendorTokenMappings.id, existing.id))
    }
  }
}

// Resolve a vendor id by name for the workspace (used to attach learning to the
// import's vendor).
export async function getVendorIdByName(name: string) {
  await requireUser()
  const [row] = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.name, name.trim()))
    .limit(1)
  return row?.id ?? null
}
