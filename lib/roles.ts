import 'server-only'

import { eq, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import {
  type Role,
  canAdmin,
  canEdit,
  normalizeRole,
} from '@/lib/roles-shared'

export {
  type Role,
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  canEdit,
  canAdmin,
} from '@/lib/roles-shared'

export type SessionUser = {
  id: string
  name: string
  email: string
  role: Role
}

// Returns the signed-in user with their app role, or null when unauthenticated.
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  // role isn't part of Better Auth's default session payload, so read it from
  // the user table to stay authoritative even if the session is stale.
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1)
  if (!row) return null
  return { ...row, role: normalizeRole(row.role) }
}

// Throws when unauthenticated; returns the session user otherwise.
export async function requireUser(): Promise<SessionUser> {
  const current = await getCurrentUser()
  if (!current) throw new Error('Unauthorized')
  return current
}

// Guard for write/edit actions. Viewers are rejected.
export async function requireEditor(): Promise<SessionUser> {
  const current = await requireUser()
  if (!canEdit(current.role)) {
    throw new Error('Forbidden: this action requires uploader or admin access.')
  }
  return current
}

// Guard for admin-only actions (user/role management).
export async function requireAdmin(): Promise<SessionUser> {
  const current = await requireUser()
  if (!canAdmin(current.role)) {
    throw new Error('Forbidden: this action requires admin access.')
  }
  return current
}

// Promote the very first registered account to admin. Safe to call whenever:
// it only assigns admin when no admin exists yet.
export async function ensureFirstUserIsAdmin(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user)
    .where(eq(user.role, 'admin'))
  if (count > 0) return
  const [first] = await db
    .select({ id: user.id })
    .from(user)
    .orderBy(user.createdAt)
    .limit(1)
  if (first) {
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, first.id))
  }
}
