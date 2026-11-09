import 'server-only'

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

// Derived from BETTER_AUTH_SECRET so no extra env var is needed. Rotating that
// secret makes previously sealed values unreadable; re-enter them afterwards.
function encryptionKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not configured.')
  return Buffer.from(
    hkdfSync('sha256', secret, 'ace-procurement', 'credential-seal-v1', 32),
  )
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv, tag, data].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join(':')
}

export function unseal(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':')
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Stored credential is in an unrecognized format.')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
