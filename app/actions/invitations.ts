'use server'

import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  invitations,
  user as userTable,
  userLocations,
  locations,
} from '@/lib/db/schema'
import { requireAdmin, getCurrentUser } from '@/lib/roles'
import { ROLES, type Role } from '@/lib/roles-shared'
import { auth } from '@/lib/auth'
import { revalidatePath } from 'next/cache'

const INVITE_TTL_DAYS = 7

function hashToken(rawToken: string) {
  return createHash('sha256').update(rawToken).digest('hex')
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function baseUrl() {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000')
  ).replace(/\/$/, '')
}

export type InvitationRow = {
  id: string
  email: string
  role: Role
  locationName: string | null
  status: string
  invitedByName: string | null
  expiresAt: Date
  acceptedAt: Date | null
  createdAt: Date
  isExpired: boolean
}

/**
 * Admin action: create an invitation and return a one-time invite link.
 * The raw token is returned ONLY here (embedded in the link) and never stored;
 * only its SHA-256 hash is persisted.
 */
export async function createInvitation(formData: {
  email: string
  role: Role
  locationId?: number | null
}): Promise<{ ok: true; inviteUrl: string; email: string } | { ok: false; error: string }> {
  await requireAdmin()

  const email = normalizeEmail(formData.email)
  const role = formData.role

  if (!isValidEmail(email)) {
    return { ok: false, error: 'Please enter a valid email address.' }
  }
  if (!ROLES.includes(role)) {
    return { ok: false, error: 'Invalid role selected.' }
  }

  // A site champion is scoped to exactly one location, assigned on acceptance.
  // Require it up front for champions, and ignore any location sent for other
  // roles (they aren't location-scoped).
  let locationId: number | null = null
  if (role === 'champion') {
    if (!formData.locationId) {
      return { ok: false, error: 'Select a site for this Site Champion.' }
    }
    const loc = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, formData.locationId))
      .limit(1)
    if (loc.length === 0) {
      return { ok: false, error: 'That site no longer exists.' }
    }
    locationId = formData.locationId
  }

  // Block inviting an email that already has an account.
  const existing = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)
  if (existing.length > 0) {
    return { ok: false, error: 'A user with that email already exists.' }
  }

  // Supersede any prior pending invite for this email so only one is live.
  await db
    .update(invitations)
    .set({ status: 'revoked' })
    .where(and(eq(invitations.email, email), eq(invitations.status, 'pending')))

  const inviter = await getCurrentUser()
  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db.insert(invitations).values({
    id: randomUUID(),
    email,
    role,
    locationId,
    tokenHash: hashToken(rawToken),
    status: 'pending',
    invitedByUserId: inviter?.id ?? null,
    invitedByName: inviter?.name ?? inviter?.email ?? null,
    expiresAt,
  })

  const inviteUrl = `${baseUrl()}/accept-invite?token=${rawToken}`

  revalidatePath('/admin')
  return { ok: true, inviteUrl, email }
}

/** Admin action: list invitations, newest first. */
export async function listInvitations(): Promise<InvitationRow[]> {
  await requireAdmin()
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      invitedByName: invitations.invitedByName,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      createdAt: invitations.createdAt,
      locationName: locations.name,
    })
    .from(invitations)
    .leftJoin(locations, eq(invitations.locationId, locations.id))
    .orderBy(desc(invitations.createdAt))
  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as Role,
    locationName: r.locationName ?? null,
    status: r.status,
    invitedByName: r.invitedByName,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt as Date,
    isExpired: r.status === 'pending' && r.expiresAt.getTime() < now,
  }))
}

/** Admin action: revoke a pending invitation. */
export async function revokeInvitation(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdmin()
  const rows = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1)
  const invite = rows[0]
  if (!invite) return { ok: false, error: 'Invitation not found.' }
  if (invite.status === 'accepted') {
    return { ok: false, error: 'That invitation has already been accepted.' }
  }
  await db.update(invitations).set({ status: 'revoked' }).where(eq(invitations.id, id))
  revalidatePath('/admin')
  return { ok: true }
}

/** Admin action: re-issue an invite (revoke + create fresh link) for an email. */
export async function resendInvitation(
  id: string,
): Promise<{ ok: true; inviteUrl: string; email: string } | { ok: false; error: string }> {
  await requireAdmin()
  const rows = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1)
  const invite = rows[0]
  if (!invite) return { ok: false, error: 'Invitation not found.' }
  if (invite.status === 'accepted') {
    return { ok: false, error: 'That invitation has already been accepted.' }
  }
  return createInvitation({
    email: invite.email,
    role: invite.role as Role,
    locationId: invite.locationId ?? null,
  })
}

/**
 * Public action: validate a raw token from the accept-invite link.
 * Returns the locked email so the page can pre-fill it. Never leaks the token.
 */
export async function validateInvitationToken(
  rawToken: string,
): Promise<
  | {
      ok: true
      email: string
      role: Role
      invitedByName: string | null
      locationName: string | null
    }
  | { ok: false; error: string }
> {
  if (!rawToken) return { ok: false, error: 'This invite link is invalid.' }
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(rawToken)))
    .limit(1)
  const invite = rows[0]
  if (!invite) return { ok: false, error: 'This invite link is invalid.' }
  if (invite.status === 'revoked') {
    return { ok: false, error: 'This invitation has been revoked. Ask an admin for a new one.' }
  }
  if (invite.status === 'accepted') {
    return { ok: false, error: 'This invitation has already been used.' }
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'This invitation has expired. Ask an admin for a new one.' }
  }

  // Resolve the assigned site name for display on the accept page (champions).
  let locationName: string | null = null
  if (invite.locationId != null) {
    const loc = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, invite.locationId))
      .limit(1)
    locationName = loc[0]?.name ?? null
  }

  return {
    ok: true,
    email: invite.email,
    role: invite.role as Role,
    invitedByName: invite.invitedByName,
    locationName,
  }
}

/**
 * Public action: accept an invite by creating the account server-side.
 * Public sign-up is disabled, so the user is created through Better Auth's
 * internal adapter after re-validating the token. The chosen password is
 * hashed with Better Auth's configured hasher.
 */
export async function acceptInvitation(input: {
  token: string
  password: string
  name: string
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const rawToken = input.token
  const password = input.password ?? ''
  const name = (input.name ?? '').trim()

  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' }
  }
  if (!name) {
    return { ok: false, error: 'Please enter your name.' }
  }

  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(rawToken)))
    .limit(1)
  const invite = rows[0]
  if (!invite || invite.status !== 'pending') {
    return { ok: false, error: 'This invite link is no longer valid.' }
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'This invitation has expired. Ask an admin for a new one.' }
  }

  const email = invite.email

  // Guard against a race where the email was registered after the invite.
  const existing = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1)
  if (existing.length > 0) {
    return { ok: false, error: 'An account with this email already exists. Try signing in.' }
  }

  const ctx = await auth.$context
  const hashedPassword = await ctx.password.hash(password)

  const now = new Date()
  const createdUser = await ctx.internalAdapter.createUser({
    id: randomUUID(),
    email,
    name,
    emailVerified: false,
    role: invite.role,
    createdAt: now,
    updatedAt: now,
  })

  await ctx.internalAdapter.linkAccount({
    userId: createdUser.id,
    providerId: 'credential',
    accountId: createdUser.id,
    password: hashedPassword,
    createdAt: now,
    updatedAt: now,
  })

  // Better Auth's createUser only persists fields it knows about, so a custom
  // `role` passed above is dropped and the column falls back to its DB default
  // ('viewer'). Set it directly to guarantee the invited role sticks — this is
  // what makes a champion actually get the champion role (and its validation-
  // only scoping) instead of silently becoming a viewer with full read access.
  if (createdUser.role !== invite.role) {
    await db
      .update(userTable)
      .set({ role: invite.role })
      .where(eq(userTable.id, createdUser.id))
  }

  // For a site champion, assign their location now that the account exists.
  // This closes the ordering gap where a champion could sign in before an
  // admin manually assigned a site and see "No locations assigned". Guarded so
  // a duplicate row can never be created if accept is somehow retried.
  if (invite.role === 'champion' && invite.locationId != null) {
    const already = await db
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, createdUser.id),
          eq(userLocations.locationId, invite.locationId),
        ),
      )
      .limit(1)
    if (already.length === 0) {
      await db.insert(userLocations).values({
        userId: createdUser.id,
        locationId: invite.locationId,
        assignedByUserId: invite.invitedByUserId,
        assignedByName: invite.invitedByName,
      })
    }
  }

  await db
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: now, acceptedByUserId: createdUser.id })
    .where(eq(invitations.id, invite.id))

  return { ok: true, email }
}
