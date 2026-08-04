'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  X,
  ArrowLeft,
  ArrowRight,
  Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  ALL_ATTRIBUTES,
  emptyLabelFor,
  type AttributeDef,
  type AttributeKey,
} from '@/lib/attributes'

export type GroupItem = {
  // Stable unique key for this item.
  id: string
  // Attribute values used for grouping. Missing / null values fall into an
  // "empty" bucket labeled per attribute.
  attributes: Partial<Record<AttributeKey, string | null>>
  // Lowercased text used for the external search filter.
  searchText: string
  // The already-rendered row/card for this item.
  node: ReactNode
}

type Props = {
  items: GroupItem[]
  // Attributes available to group by on this screen, in offer order.
  available: AttributeDef[]
  // Initial ordered grouping (subset of `available` keys).
  defaultGroupBy: AttributeKey[]
  // Namespace for persisting grouping config + expand state in localStorage.
  storageKey: string
  // External search string. When non-empty, matching groups auto-expand.
  query?: string
  // Force every group open regardless of expand state — used when the parent
  // already applied its own filtering (e.g. Compare's pack-family filter) and
  // wants results visible without manual expansion.
  forceExpand?: boolean
  // Noun for counts, e.g. "products".
  itemLabel?: string
}

type PersistedState = {
  groupBy: AttributeKey[]
  expanded: string[]
}

function labelFor(key: AttributeKey): string {
  return ALL_ATTRIBUTES.find((a) => a.key === key)?.label ?? key
}

// A node in the built grouping tree.
type TreeGroup = {
  path: string
  label: string
  key: AttributeKey
  count: number
  children: TreeGroup[]
  // Leaf items live only on the deepest groups (or the root when no grouping).
  items: GroupItem[]
}

export function AttributeGroupedList({
  items,
  available,
  defaultGroupBy,
  storageKey,
  query = '',
  forceExpand = false,
  itemLabel = 'items',
}: Props) {
  const lsKey = `attr-group:v1:${storageKey}`

  const [groupBy, setGroupBy] = useState<AttributeKey[]>(defaultGroupBy)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [hydrated, setHydrated] = useState(false)

  // Load persisted config on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey)
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState
        if (Array.isArray(parsed.groupBy)) {
          // Only keep keys still valid for this screen.
          const valid = parsed.groupBy.filter((k) =>
            available.some((a) => a.key === k),
          )
          setGroupBy(valid)
        }
        if (Array.isArray(parsed.expanded)) {
          setExpanded(new Set(parsed.expanded))
        }
      }
    } catch {
      // ignore malformed storage
    }
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lsKey])

  // Persist on change (after hydration so we don't clobber saved state).
  useEffect(() => {
    if (!hydrated) return
    try {
      const state: PersistedState = {
        groupBy,
        expanded: Array.from(expanded),
      }
      localStorage.setItem(lsKey, JSON.stringify(state))
    } catch {
      // ignore quota / unavailable storage
    }
  }, [groupBy, expanded, hydrated, lsKey])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (q ? items.filter((it) => it.searchText.includes(q)) : items),
    [items, q],
  )

  // Build the nested grouping tree from the filtered items.
  const tree = useMemo(
    () => buildTree(filtered, groupBy),
    [filtered, groupBy],
  )

  // Collect every group path (for expand-all).
  const allPaths = useMemo(() => {
    const paths: string[] = []
    const walk = (groups: TreeGroup[]) => {
      for (const g of groups) {
        paths.push(g.path)
        walk(g.children)
      }
    }
    walk(tree)
    return paths
  }, [tree])

  const searching = q.length > 0
  const forceOpen = searching || forceExpand

  const isOpen = useCallback(
    (path: string) => forceOpen || expanded.has(path),
    [forceOpen, expanded],
  )

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function expandAll() {
    setExpanded(new Set(allPaths))
  }
  function collapseAll() {
    setExpanded(new Set())
  }

  // --- Group-by editing ---
  function addAttr(key: AttributeKey) {
    setGroupBy((prev) => [...prev, key])
  }
  function removeAttr(key: AttributeKey) {
    setGroupBy((prev) => prev.filter((k) => k !== key))
  }
  function move(index: number, dir: -1 | 1) {
    setGroupBy((prev) => {
      const next = [...prev]
      const j = index + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  const remaining = available.filter((a) => !groupBy.includes(a.key))

  return (
    <div className="flex flex-col gap-4">
      {/* Group-by control bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Layers className="size-4" aria-hidden="true" />
          Group by
        </span>

        {groupBy.length === 0 && (
          <span className="text-sm text-muted-foreground">
            None — showing a flat list
          </span>
        )}

        <ol className="flex flex-wrap items-center gap-1.5">
          {groupBy.map((key, i) => (
            <li key={key} className="flex items-center gap-1.5">
              {i > 0 && (
                <ChevronRight
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/60 py-0.5 pl-2 pr-0.5 text-sm">
                <span className="font-medium">{labelFor(key)}</span>
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${labelFor(key)} earlier`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background disabled:opacity-30"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === groupBy.length - 1}
                  aria-label={`Move ${labelFor(key)} later`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background disabled:opacity-30"
                >
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAttr(key)}
                  aria-label={`Remove ${labelFor(key)} grouping`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ol>

        {remaining.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" className="h-7 gap-1" />
              }
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add level
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {remaining.map((a) => (
                <DropdownMenuItem key={a.key} onClick={() => addAttr(a.key)}>
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-muted-foreground"
            onClick={expandAll}
            disabled={groupBy.length === 0}
          >
            <ChevronsUpDown className="size-3.5" aria-hidden="true" />
            Expand all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-muted-foreground"
            onClick={collapseAll}
            disabled={groupBy.length === 0}
          >
            <ChevronsDownUp className="size-3.5" aria-hidden="true" />
            Collapse all
          </Button>
        </div>
      </div>

      {/* Grouped content */}
      {filtered.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          No {itemLabel} match your filters.
        </p>
      ) : groupBy.length === 0 ? (
        // Flat list
        <div className="flex flex-col gap-3">
          {filtered.map((it) => (
            <div key={it.id}>{it.node}</div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tree.map((g) => (
            <GroupPanel
              key={g.path}
              group={g}
              depth={0}
              isOpen={isOpen}
              onToggle={toggle}
              itemLabel={itemLabel}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GroupPanel({
  group,
  depth,
  isOpen,
  onToggle,
  itemLabel,
}: {
  group: TreeGroup
  depth: number
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  itemLabel: string
}) {
  const open = isOpen(group.path)
  const hasChildren = group.children.length > 0

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card',
        depth > 0 && 'bg-muted/20',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(group.path)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
      >
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {labelForShort(group.key)}
        </span>
        <span className="truncate font-medium text-foreground">
          {group.label}
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {group.count} {itemLabel}
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          {hasChildren ? (
            <div className="flex flex-col gap-2">
              {group.children.map((child) => (
                <GroupPanel
                  key={child.path}
                  group={child}
                  depth={depth + 1}
                  isOpen={isOpen}
                  onToggle={onToggle}
                  itemLabel={itemLabel}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {group.items.map((it) => (
                <div key={it.id}>{it.node}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function labelForShort(key: AttributeKey): string {
  return labelFor(key)
}

// Build a nested tree of groups from a flat item list and an ordered set of
// grouping keys. Groups are sorted alphabetically, with the "empty" bucket
// pushed to the end.
function buildTree(items: GroupItem[], groupBy: AttributeKey[]): TreeGroup[] {
  if (groupBy.length === 0) return []

  function group(items: GroupItem[], level: number, parentPath: string): TreeGroup[] {
    const key = groupBy[level]
    const buckets = new Map<string, GroupItem[]>()
    for (const it of items) {
      const raw = it.attributes[key]
      const label = raw == null || raw === '' ? emptyLabelFor(key) : raw
      const list = buckets.get(label)
      if (list) list.push(it)
      else buckets.set(label, [it])
    }

    const isEmptyLabel = (l: string) => l === emptyLabelFor(key)
    const labels = Array.from(buckets.keys()).sort((a, b) => {
      // Empty bucket last.
      if (isEmptyLabel(a) && !isEmptyLabel(b)) return 1
      if (!isEmptyLabel(a) && isEmptyLabel(b)) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })

    return labels.map((label) => {
      const bucketItems = buckets.get(label) as GroupItem[]
      const path = `${parentPath}/${key}=${label}`
      const isLast = level === groupBy.length - 1
      return {
        path,
        label,
        key,
        count: bucketItems.length,
        children: isLast ? [] : group(bucketItems, level + 1, path),
        items: isLast ? bucketItems : [],
      }
    })
  }

  return group(items, 0, '')
}
