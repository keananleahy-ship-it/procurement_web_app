// TEMP: create a throwaway verification user via Better Auth's server API
// (bypasses the public disableSignUp), then print creds. Deleted afterward.
import { auth } from '../lib/auth.ts'
import { Pool } from 'pg'

const email = 'v0-verify@example.com'
const password = 'Verify123!pass'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  // Clean any prior run.
  await pool.query('DELETE FROM "user" WHERE email = $1', [email])
  const res = await auth.api.signUpEmail({
    body: { email, password, name: 'V0 Verify' },
  })
  const userId = res.user?.id
  // Promote to admin so editor-only controls (attribute editor) render.
  await pool.query('UPDATE "user" SET role = $2 WHERE id = $1', [
    userId,
    'admin',
  ])
  console.log('CREATED', email, password, 'id=', userId)
  await pool.end()
}

main().catch((e) => {
  console.error('FAILED', e.message)
  process.exit(1)
})
