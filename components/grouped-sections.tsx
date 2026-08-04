'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collectSubtreeIds,
  type EntityType,
  type GroupNode,
} from '@/lib/groups'
import { Button } from '@/components/ui/button'
import { GroupHeaderMenu, NewGroupButton } from '@/components/group-controls'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// "Ungrouped" bucket is keyed with this sentinel in the expand-state set.
const UNGROUPED_KEY = -1

type GroupedSectionsProps<T> = {
  // Stable per-screen key so expand/collapse state is remembered separately for
  // each screen between visits (persisted to localStorage).
  storageKey: string
  tree: GroupNode[]
  entityType: EntityType
  canEdit: boolean
  // Items bucketed by their group id; the `null` key holds Ungrouped items.
  itemsByGroup: Map<number | null, T[]>
  // Render a bucket of items (e.g. a table or a stack of cards).
  renderItems: (items: T[]) => React.ReactNode
  // When true (e.g. a search/filter is active) every group is force-expanded so
  // matches are never hidden inside a collapsed group. Stored state is left
  // untouched and restored when the filter clears.
  forceExpandAll?: boolean
  // Total item count used for the header summary line.
  totalCount: number
  // Optional label for the count (e.g. "products", "items").
  itemNoun?: string
}

function readStored(storageKey: string): Set<number> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`groups:expanded:${storageKey}`)
    if (!raw) return null
    const arr = JSON.parse(raw) as number[]
    return new Set(arr)
  } catch {
    return null
  }
}

export function GroupedSections<T>({
  storageKey,
  tree,
  entityType,
  canEdit,
  itemsByGroup,
  renderItems,
  forceExpandAll = false,
  totalCount,
  itemNoun = 'items',
}: GroupedSectionsProps<T>) {
  // All expandable section ids: every group id plus the Ungrouped sentinel.
  const allIds = useMemo(() => {
    const ids: number[] = [UNGROUPED_KEY]
    const walk = (nodes: GroupNode[]) => {
      for (const n of nodes) {
        ids.push(n.id)
        walk(n.children)
      }
    }
    walk(tree)
    return ids
  }, [tree])

  // Expanded by default on first visit (no stored state) so items are visible;
  // afterward the user's last choice is restored.
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const stored = readStored(storageKey)
    return stored ?? new Set(allIds)
  })

  // Persist whenever the set changes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        `groups:expanded:${storageKey}`,
        JSON.stringify([...expanded]),
      )
    } catch {
      // ignore quota / private-mode errors
    }
  }, [expanded, storageKey])

  const isOpen = useCallback(
    (id: number) => forceExpandAll || expanded.has(id),
    [forceExpandAll, expanded],
  )

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Rolled-up count for a group = its own items + all descendants' items.
  const countFor = useCallback(
    (node: GroupNode) => {
      let total = 0
      for (const id of collectSubtreeIds(node)) {
        total += itemsByGroup.get(id)?.length ?? 0
      }
      return total
    },
    [itemsByGroup],
  )

  const ungrouped = itemsByGroup.get(null) ?? []

  // No groups defined yet: render items flat, with a create-group affordance
  // for editors so the hierarchy can be started.
  if (tree.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {canEdit && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              No groups yet. Create groups to organize these {itemNoun} into a
              hierarchy you can roll up or expand.
            </p>
            <NewGroupButton tree={tree} />
          </div>
        )}
        {renderItems(ungrouped)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {totalCount} {itemNoun} across {tree.length} top-level group
          {tree.length === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={() => setExpanded(new Set(allIds))}
          >
            <ChevronsUpDown className="size-4" />
            Expand all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={() => setExpanded(new Set())}
          >
            <ChevronsDownUp className="size-4" />
            Collapse all
          </Button>
          {canEdit && <NewGroupButton tree={tree} />}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {tree.map((node) => (
          <GroupSection
            key={node.id}
            node={node}
            tree={tree}
            entityType={entityType}
            canEdit={canEdit}
            itemsByGroup={itemsByGroup}
            renderItems={renderItems}
            isOpen={isOpen}
            toggle={toggle}
            countFor={countFor}
          />
        ))}

        {/* Items not assigned to any group. */}
        {ungrouped.length > 0 && (
          <SectionShell
            open={isOpen(UNGROUPED_KEY)}
            onToggle={() => toggle(UNGROUPED_KEY)}
            depth={0}
            title="Ungrouped"
            count={ungrouped.length}
            muted
          >
            {renderItems(ungrouped)}
          </SectionShell>
        )}
      </div>
    </div>
  )
}

function GroupSection<T>({
  node,
  tree,
  entityType,
  canEdit,
  itemsByGroup,
  renderItems,
  isOpen,
  toggle,
  countFor,
}: {
  node: GroupNode
  tree: GroupNode[]
  entityType: EntityType
  canEdit: boolean
  itemsByGroup: Map<number | null, T[]>
  renderItems: (items: T[]) => React.ReactNode
  isOpen: (id: number) => boolean
  toggle: (id: number) => void
  countFor: (node: GroupNode) => number
}) {
  const ownItems = itemsByGroup.get(node.id) ?? []
  const open = isOpen(node.id)

  return (
    <SectionShell
      open={open}
      onToggle={() => toggle(node.id)}
      depth={node.depth}
      title={node.name}
      count={countFor(node)}
      actions={canEdit ? <GroupHeaderMenu group={node} tree={tree} /> : null}
    >
      <div className="flex flex-col gap-2">
        {ownItems.length > 0 && renderItems(ownItems)}
        {node.children.map((child) => (
          <GroupSection
            key={child.id}
            node={child}
            tree={tree}
            entityType={entityType}
            canEdit={canEdit}
            itemsByGroup={itemsByGroup}
            renderItems={renderItems}
            isOpen={isOpen}
            toggle={toggle}
            countFor={countFor}
          />
        ))}
        {ownItems.length === 0 && node.children.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No items in this group yet.
          </p>
        )}
      </div>
    </SectionShell>
  )
}

// Shared collapsible panel chrome used for both groups and the Ungrouped bucket.
function SectionShell({
  open,
  onToggle,
  depth,
  title,
  count,
  actions,
  muted,
  children,
}: {
  open: boolean
  onToggle: () => void
  depth: number
  title: string
  count: number
  actions?: React.ReactNode
  muted?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-lg border border-border bg-card"
      style={{ marginLeft: depth * 16 }}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2.5',
          open && 'border-b border-border',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <span
            className={cn(
              'truncate font-medium',
              muted ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {title}
          </span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </button>
        {actions}
      </div>
      {open && <div className="p-3">{children}</div>}
    </div>
  )
}
