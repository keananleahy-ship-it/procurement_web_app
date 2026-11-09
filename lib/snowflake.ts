import 'server-only'

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import snowflake from 'snowflake-sdk'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { snowflakeConnection } from '@/lib/db/schema'
import { unseal } from '@/lib/secret-box'

// The SDK otherwise writes snowflake.log into the working directory, which is
// read-only on Vercel. Errors are surfaced to callers instead.
snowflake.configure({ logLevel: 'OFF' })

export type ParsedKey = {
  pkcs8Pem: string
  publicKeyPem: string
  fingerprint: string
}

// Accepts PKCS#8 (encrypted or not) or PKCS#1 RSA PEM. Returns an unencrypted
// PKCS#8 copy for the driver plus the fingerprint in the same format Snowflake
// reports for RSA_PUBLIC_KEY_FP, so admins can verify it with DESC USER.
export function parsePrivateKey(pem: string, passphrase?: string): ParsedKey {
  let key
  try {
    key = createPrivateKey({
      key: pem.trim(),
      format: 'pem',
      passphrase: passphrase || undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/passphrase|decrypt|interrupted|cancelled/i.test(message)) {
      throw new Error(
        'Could not decrypt the private key. Check the passphrase (leave it blank for unencrypted keys).',
      )
    }
    throw new Error(
      'Not a valid PEM private key. Paste the full contents of the .p8 file, including the BEGIN/END lines.',
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('Snowflake key-pair auth requires an RSA key.')
  }
  const publicKey = createPublicKey(key)
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
  return {
    pkcs8Pem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: `SHA256:${createHash('sha256').update(spkiDer).digest('base64')}`,
  }
}

// Accepts "orgname-acctname", a locator like "xy12345.us-east-1", or a full URL.
export function normalizeAccount(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.snowflakecomputing\.com.*$/i, '')
    .replace(/\/.*$/, '')
}

type ConnectionConfig = {
  account: string
  username: string
  role: string | null
  warehouse: string | null
  database: string | null
  schema: string | null
  privateKey: string
}

async function loadConfig(): Promise<ConnectionConfig> {
  const [row] = await db
    .select()
    .from(snowflakeConnection)
    .where(eq(snowflakeConnection.id, 1))
    .limit(1)
  if (!row) throw new Error('Snowflake is not configured yet.')
  return {
    account: row.account,
    username: row.username,
    role: row.role,
    warehouse: row.warehouse,
    database: row.database,
    schema: row.schema,
    privateKey: unseal(row.privateKeySealed),
  }
}

const CONNECT_TIMEOUT_MS = 25_000

async function withConnection<T>(
  fn: (conn: snowflake.Connection) => Promise<T>,
): Promise<T> {
  const cfg = await loadConfig()
  const conn = snowflake.createConnection({
    account: cfg.account,
    username: cfg.username,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: cfg.privateKey,
    role: cfg.role ?? undefined,
    warehouse: cfg.warehouse ?? undefined,
    database: cfg.database ?? undefined,
    schema: cfg.schema ?? undefined,
    application: 'AceProcurement',
    timeout: 20_000,
    sfRetryMaxLoginRetries: 1,
  })
  // The SDK retries unreachable hosts with backoff for minutes; cap the wait
  // so a wrong account identifier fails fast instead of hanging the request.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        conn.connect((err) => (err ? reject(err) : resolve()))
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Timed out reaching Snowflake. Check the account identifier and any network policy.',
              ),
            ),
          CONNECT_TIMEOUT_MS,
        )
      }),
    ])
  } catch (err) {
    conn.destroy(() => {})
    throw err
  } finally {
    clearTimeout(timer)
  }
  try {
    return await fn(conn)
  } finally {
    conn.destroy(() => {})
  }
}

function execute<T>(
  conn: snowflake.Connection,
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) =>
        err ? reject(err) : resolve((rows ?? []) as T[]),
    })
  })
}

const READ_ONLY_STATEMENT = /^\s*(select|with|show|describe|desc)\b/i

// Defense in depth only: the Snowflake role granted to this service user is
// the real guarantee that the app cannot write. This just stops the app code
// from ever issuing anything other than a read.
export async function querySnowflake<T = Record<string, unknown>>(
  sqlText: string,
  binds: snowflake.Binds = [],
): Promise<T[]> {
  if (!READ_ONLY_STATEMENT.test(sqlText) || sqlText.includes(';')) {
    throw new Error('Only single read-only statements are allowed.')
  }
  return withConnection((conn) => execute<T>(conn, sqlText, binds))
}

export type SnowflakeSessionInfo = {
  user: string
  role: string | null
  warehouse: string | null
  database: string | null
  schema: string | null
  version: string
}

export async function probeSnowflake(): Promise<SnowflakeSessionInfo> {
  const [row] = await querySnowflake<Record<string, string | null>>(
    `select current_user() as "user", current_role() as "role",
            current_warehouse() as "warehouse", current_database() as "database",
            current_schema() as "schema", current_version() as "version"`,
  )
  return {
    user: row.user ?? '',
    role: row.role,
    warehouse: row.warehouse,
    database: row.database,
    schema: row.schema,
    version: row.version ?? '',
  }
}
