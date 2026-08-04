'use server'

import { db } from '@/lib/db'
import { groupMembers, itemGroups } from '@/lib/db/schema'
import { requireUser, requireEditor } from '@/lib/roles'
import {
  buildGroupTree,
  collectSubtreeIds,
  type EntityType,
  type GroupNode,
  type MembershipMap,
} from '@/lib/groups'
import { and, asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

// Screens that show the hierarchy — revalidated together on every mutation so
// a group change made from one screen is reflected everywhere.
const HIERARCHY_PATHS = ['/compare', '/products', '/canonical', '/']

function revalidateHierarchy() {
  for (const p of HIERARCHY_PATHS) revalidatePath(p)
}

/** The full nested group tree (workspace-wide). Any signed-in user may read. */
export async function getGroupTree(): Promise<GroupNode[]> {
  await requireUser()
  const rows = await db
    .select({
      id: itemGroups.id,
      name: itemGroups.name,
      parentId: itemGroups.parentId,
      sortOrder: itemGroups.sortOrder,
    })
    .from(itemGroups)
    .orderBy(asc(itemGroups.sortOrder), asc(itemGroups.name))
  return buildGroupTree(rows)
}

/**
 * Membership map for one entity type: entityId -> groupId. Items without a row
 * are Ungrouped and simply absent from the map.
 */
export async function getGroupMemberships(
  entityType: EntityType,
): Promise<MembershipMap> {
  await requireUser()
  const rows = await db
    .select({
      entityId: groupMembers.entityId,
      groupId: groupMembers.groupId,
    })
    .from(groupMembers)
    .where(eq(groupMembers.entityType, entityType))
  const map: MembershipMap = {}
  for (const r of rows) map[r.entityId] = r.groupId
  return map
}

/** Create a group (optionally nested under a parent). Editors only. */
export async function createGroup(input: {
  name: string
  parentId?: number | null
}): Promise<{ id: number }> {
  const { id: userId } = await requireEditor()
  const name = input.name.trim()
  if (!name) throw new Error('Group name is required')
  const parentId = input.parentId ?? null

  // Guard against pointing a group at a non-existent parent.
  if (parentId != null) {
    const [parent] = await db
      .select({ id: itemGroups.id })
      .from(itemGroups)
      .where(eq(itemGroups.id, parentId))
      .limit(1)
    if (!parent) throw new Error('Parent group not found')
  }

  const [row] = await db
    .insert(itemGroups)
    .values({ userId, name, parentId })
    .returning({ id: itemGroups.id })
  revalidateHierarchy()
  return { id: row.id }
}

/** Rename a group. Editors only. */
export async function renameGroup(id: number, name: string): Promise<void> {
  await requireEditor()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Group name is required')
  await db
    .update(itemGroups)
    .set({ name: trimmed })
    .where(eq(itemGroups.id, id))
  revalidateHierarchy()
}

/**
 * Delete a group. Its direct children are reparented to the deleted group's
 * parent (so subgroups aren't orphaned), and its item memberships are removed
 * (those items become Ungrouped). Editors only.
 */
export async function deleteGroup(id: number): Promise<void> {
  await requireEditor()
  const [group] = await db
    .select({ id: itemGroups.id, parentId: itemGroups.parentId })
    .from(itemGroups)
    .where(eq(itemGroups.id, id))
    .limit(1)
  if (!group) return

  // Reparent direct children up one level.
  await db
    .update(itemGroups)
    .set({ parentId: group.parentId })
    .where(eq(itemGroups.parentId, id))

  // Unassign items that lived in this group.
  await db.delete(groupMembers).where(eq(groupMembers.groupId, id))

  await db.delete(itemGroups).where(eq(itemGroups.id, id))
  revalidateHierarchy()
}

/**
 * Reparent a group. Rejects moving a group under itself or one of its own
 * descendants (which would create a cycle). Editors only.
 */
export async function moveGroup(
  id: number,
  parentId: number | null,
): Promise<void> {
  await requireEditor()
  if (parentId === id) throw new Error('A group cannot be its own parent')

  if (parentId != null) {
    const tree = await getGroupTree()
    // Find the node being moved and ensure the target isn't in its subtree.
    let moving: GroupNode | undefined
    const find = (nodes: GroupNode[]) => {
      for (const n of nodes) {
        if (n.id === id) moving = n
        else find(n.children)
      }
    }
    find(tree)
    if (moving && collectSubtreeIds(moving).includes(parentId)) {
      throw new Error('Cannot move a group into its own subgroup')
    }
  }

  await db
    .update(itemGroups)
    .set({ parentId })
    .where(eq(itemGroups.id, id))
  revalidateHierarchy()
}

/**
 * Assign an item to a group, or move it to Ungrouped when groupId is null.
 * Enforces the single-group rule (one membership per item). Editors only.
 */
export async function assignItemToGroup(input: {
  entityType: EntityType
  entityId: number
  groupId: number | null
}): Promise<void> {
  const { id: userId } = await requireEditor()
  const { entityType, entityId, groupId } = input

  // Remove any existing membership first (single group per item).
  await db
    .delete(groupMembers)
    .where(
      and(
        eq(groupMembers.entityType, entityType),
        eq(groupMembers.entityId, entityId),
      ),
    )

  if (groupId != null) {
    const [group] = await db
      .select({ id: itemGroups.id })
      .from(itemGroups)
      .where(eq(itemGroups.id, groupId))
      .limit(1)
    if (!group) throw new Error('Group not found')
    await db
      .insert(groupMembers)
      .values({ userId, groupId, entityType, entityId })
  }

  revalidateHierarchy()
}
