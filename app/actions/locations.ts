'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { locations } from '@/lib/db/schema'
import { and, asc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getLocations() {
  const userId = await getUserId()
  return db
    .select()
    .from(locations)
    .where(eq(locations.userId, userId))
    .orderBy(asc(locations.name))
}

export async function createLocation(formData: FormData) {
  const userId = await getUserId()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Location name is required')
  const region = String(formData.get('region') ?? '').trim() || null

  await db.insert(locations).values({ userId, name, region })
  revalidatePath('/locations')
  revalidatePath('/')
}

export async function deleteLocation(id: number) {
  const userId = await getUserId()
  await db
    .delete(locations)
    .where(and(eq(locations.id, id), eq(locations.userId, userId)))
  revalidatePath('/locations')
  revalidatePath('/')
}
