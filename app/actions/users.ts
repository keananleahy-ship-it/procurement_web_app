'use server'

import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { type Role, ROLES, requireAdmin } from '@/lib/roles'
import { normalizeRole } from '@/lib/roles-shared'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export type ManagedUser = {
  id: string
  name: string
  email: string
  role: Role
  createdAt: string | null
}

export async function getUsers(): Promise<ManagedUser[]> {
  await requireAdmin()
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(asc(user.createdAt))
  return rows.map((r) => ({
    ...r,
    role: normalizeRole(r.role),
    createdAt: r.createdAt
      ? new Date(r.createdAt as unknown as string).toISOString()
      : null,
  }))
}

export async function setUserRole(userId: string, role: Role) {
  const admin = await requireAdmin()
  if (!ROLES.includes(role)) throw new Error('Invalid role')

  // Guard: never allow removing the last admin (an admin demoting themselves
  // or another admin when they are the only one left).
  if (role !== 'admin') {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user)
      .where(eq(user.role, 'admin'))
    const [target] = await db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (target?.role === 'admin' && count <= 1) {
      throw new Error('Cannot remove the last admin. Promote someone first.')
    }
  }

  await db.update(user).set({ role }).where(eq(user.id, userId))
  revalidatePath('/admin')
}

export async function deleteUser(userId: string) {
  const admin = await requireAdmin()
  if (userId === admin.id) {
    throw new Error('You cannot delete your own account.')
  }
  // Don't allow deleting the last admin.
  const [target] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (target?.role === 'admin') {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(user)
      .where(and(eq(user.role, 'admin'), ne(user.id, userId)))
    if (count === 0) {
      throw new Error('Cannot delete the last admin.')
    }
  }
  await db.delete(user).where(eq(user.id, userId))
  revalidatePath('/admin')
}
