// Shared, client-safe types and helpers for the user-defined item hierarchy.
// No `server-only` import here so both server actions and client components can
// use these.

export type EntityType = 'product' | 'canonical'

// A flat group row as stored in the DB.
export type GroupRow = {
  id: number
  name: string
  parentId: number | null
  sortOrder: number
}

// A group with its children nested underneath it.
export type GroupNode = GroupRow & {
  depth: number
  children: GroupNode[]
}

// Membership map: entityId -> groupId. A missing entry means the item is
// Ungrouped.
export type MembershipMap = Record<number, number>

/**
 * Build a nested tree from a flat list of group rows. Groups are ordered by
 * `sortOrder` then name within each parent. `depth` is assigned so the UI can
 * indent nested groups. Any row whose parent is missing (e.g. an orphaned
 * subgroup after a bad delete) is treated as top-level so it never disappears.
 */
export function buildGroupTree(rows: GroupRow[]): GroupNode[] {
  const byId = new Map<number, GroupNode>()
  for (const r of rows) {
    byId.set(r.id, { ...r, depth: 0, children: [] })
  }

  const roots: GroupNode[] = []
  for (const node of byId.values()) {
    const parent =
      node.parentId != null ? byId.get(node.parentId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortNodes = (nodes: GroupNode[], depth: number) => {
    nodes.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    )
    for (const n of nodes) {
      n.depth = depth
      sortNodes(n.children, depth + 1)
    }
  }
  sortNodes(roots, 0)
  return roots
}

/**
 * Flatten a tree into an ordered list (depth-first), preserving nesting order.
 * Handy for rendering indented <option>s in a group picker.
 */
export function flattenTree(tree: GroupNode[]): GroupNode[] {
  const out: GroupNode[] = []
  const walk = (nodes: GroupNode[]) => {
    for (const n of nodes) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(tree)
  return out
}

/**
 * Collect a group's id plus every descendant group id. Used to roll up item
 * counts and to prevent a group from being reparented under its own subtree.
 */
export function collectSubtreeIds(node: GroupNode): number[] {
  const ids: number[] = [node.id]
  for (const child of node.children) {
    ids.push(...collectSubtreeIds(child))
  }
  return ids
}
