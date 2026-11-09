'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { snowflakeConnection } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/roles'
import { seal } from '@/lib/secret-box'
import { normalizeAccount, parsePrivateKey, probeSnowflake } from '@/lib/snowflake'

export type SnowflakeSettings = {
  account: string
  username: string
  role: string
  warehouse: string
  database: string
  schema: string
  publicKeyFingerprint: string
  publicKeyPem: string
  updatedAt: string
  lastTestedAt: string | null
  lastTestOk: boolean | null
  lastTestMessage: string | null
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string }

// Never returns the private key, sealed or otherwise.
export async function getSnowflakeSettings(): Promise<SnowflakeSettings | null> {
  await requireAdmin()
  const [row] = await db
    .select()
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)
  if (!row) return null
  return {
    account: row.account,
    username: row.username,
    role: row.role ?? '',
    warehouse: row.warehouse ?? '',
    database: row.database ?? '',
    schema: row.schema ?? '',
    publicKeyFingerprint: row.publicKeyFingerprint,
    publicKeyPem: row.publicKeyPem,
    updatedAt: row.updatedAt.toISOString(),
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
  }
}

const identifier = z
  .string()
  .trim()
  .max(255)
  .regex(/^[A-Za-z0-9_$."-]*$/, 'Use letters, numbers, _, $, . or quoted names.')

const settingsSchema = z.object({
  account: z
    .string()
    .trim()
    .min(1, 'Account identifier is required.')
    .transform(normalizeAccount)
    .pipe(z.string().regex(/^[A-Za-z0-9._-]+$/, 'Invalid account identifier.')),
  username: identifier.min(1, 'Service user is required.'),
  role: identifier,
  warehouse: identifier,
  database: identifier,
  schema: identifier,
  privateKey: z.string().max(20_000),
  passphrase: z.string().max(1024),
})

export async function saveSnowflakeSettings(
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  const parsed = settingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }
  const data = parsed.data

  const [existing] = await db
    .select({ id: snowflakeConnection.id })
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)

  let keyFields: {
    privateKeySealed: string
    publicKeyFingerprint: string
    publicKeyPem: string
  } | null = null

  if (data.privateKey.trim()) {
    try {
      const key = parsePrivateKey(data.privateKey, data.passphrase)
      keyFields = {
        privateKeySealed: seal(key.pkcs8Pem),
        publicKeyFingerprint: key.fingerprint,
        publicKeyPem: key.publicKeyPem,
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Invalid key.' }
    }
  } else if (!existing) {
    return { ok: false, message: 'A private key is required for the first save.' }
  }

  const fields = {
    account: data.account,
    username: data.username,
    role: data.role || null,
    warehouse: data.warehouse || null,
    database: data.database || null,
    schema: data.schema || null,
    updatedBy: admin.email,
    updatedAt: new Date(),
    lastTestedAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    ...keyFields,
  }

  if (existing) {
    await db.update(snowflakeConnection).set(fields).where(eq(snowflakeConnection.id, 1))
  } else if (keyFields) {
    await db.insert(snowflakeConnection).values({ id: 1, ...fields, ...keyFields })
  }

  revalidatePath('/data-sources')
  return { ok: true, message: 'Connection saved. Run a test to confirm access.' }
}

export async function testSnowflakeConnection(): Promise<ActionResult> {
  await requireAdmin()
  let result: ActionResult
  try {
    const info = await probeSnowflake()
    result = {
      ok: true,
      message: `Connected as ${info.user} using role ${info.role ?? '(default)'}, warehouse ${info.warehouse ?? '(none)'}, Snowflake ${info.version}.`,
    }
  } catch (err) {
    result = {
      ok: false,
      message: err instanceof Error ? err.message : 'Connection failed.',
    }
  }
  await db
    .update(snowflakeConnection)
    .set({
      lastTestedAt: new Date(),
      lastTestOk: result.ok,
      lastTestMessage: result.message.slice(0, 1000),
    })
    .where(eq(snowflakeConnection.id, 1))
  revalidatePath('/data-sources')
  return result
}

export async function deleteSnowflakeSettings(): Promise<ActionResult> {
  await requireAdmin()
  await db.delete(snowflakeConnection).where(eq(snowflakeConnection.id, 1))
  revalidatePath('/data-sources')
  return { ok: true, message: 'Snowflake connection removed.' }
}
