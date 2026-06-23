'use server'

import { db } from '@/lib/db'
import { locations } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import { asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export async function getLocations() {
  await requireUser()
  return db.select().from(locations).orderBy(asc(locations.name))
}

export async function createLocation(formData: FormData) {
  const { id: userId } = await requireEditor()
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Location name is required')
  const region = String(formData.get('region') ?? '').trim() || null

  await db.insert(locations).values({ userId, name, region })
  revalidatePath('/locations')
  revalidatePath('/')
}

export async function deleteLocation(id: number) {
  await requireEditor()
  await db.delete(locations).where(eq(locations.id, id))
  revalidatePath('/locations')
  revalidatePath('/')
}
