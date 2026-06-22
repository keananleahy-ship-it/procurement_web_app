'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { vendors } from '@/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getVendors() {
  const userId = await getUserId()
  return db
    .select()
    .from(vendors)
    .where(eq(vendors.userId, userId))
    .orderBy(asc(vendors.name))
}

export async function createVendor(formData: FormData) {
  const userId = await getUserId()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Vendor name is required')
  const contactEmail = String(formData.get('contactEmail') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null

  await db.insert(vendors).values({ userId, name, contactEmail, notes })
  revalidatePath('/vendors')
  revalidatePath('/')
}

export async function deleteVendor(id: number) {
  const userId = await getUserId()
  await db
    .delete(vendors)
    .where(and(eq(vendors.id, id), eq(vendors.userId, userId)))
  revalidatePath('/vendors')
  revalidatePath('/')
}
