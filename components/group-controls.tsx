'use client'

import { useState, useTransition } from 'react'
import {
  assignItemToGroup,
  createGroup,
  deleteGroup,
  renameGroup,
} from '@/app/actions/groups'
import {
  flattenTree,
  type EntityType,
  type GroupNode,
} from '@/lib/groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  FolderPlus,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'

// Prefix an indent so nested groups read as a hierarchy in flat lists/menus.
function indent(depth: number) {
  return depth > 0 ? `${'\u00A0\u00A0'.repeat(depth)}` : ''
}

/**
 * Editor-only button that opens a dialog to create a new group, optionally
 * nested under an existing one.
 */
export function NewGroupButton({
  tree,
  defaultParentId = null,
  size = 'sm',
  variant = 'outline',
  label = 'New group',
}: {
  tree: GroupNode[]
  defaultParentId?: number | null
  size?: 'sm' | 'default'
  variant?: 'outline' | 'default' | 'ghost'
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(defaultParentId)
  const [isPending, startTransition] = useTransition()
  const flat = flattenTree(tree)

  function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      await createGroup({ name: trimmed, parentId })
      setName('')
      setParentId(defaultParentId)
      setOpen(false)
    })
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => setOpen(true)}
        className="gap-1.5"
      >
        <FolderPlus className="size-4" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>
              Groups organize items into a hierarchy you can roll up or expand.
              Nest a group under a parent to create a subgroup.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1">
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-name">Group name</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Facilities"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-parent">Parent group</Label>
              <select
                id="group-parent"
                value={parentId ?? ''}
                onChange={(e) =>
                  setParentId(e.target.value ? Number(e.target.value) : null)
                }
                className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Top level (no parent)</option>
                {flat.map((g) => (
                  <option key={g.id} value={g.id}>
                    {indent(g.depth)}
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={isPending || !name.trim()}>
              {isPending ? 'Creating…' : 'Create group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Per-item control to move an item into a group (or to Ungrouped). Rendered
 * inside each screen's row/card for editors.
 */
export function GroupPicker({
  tree,
  entityType,
  entityId,
  currentGroupId,
  label = 'Group',
}: {
  tree: GroupNode[]
  entityType: EntityType
  entityId: number
  currentGroupId: number | null
  label?: string
}) {
  const [isPending, startTransition] = useTransition()
  const flat = flattenTree(tree)
  const current =
    currentGroupId != null
      ? flat.find((g) => g.id === currentGroupId)
      : undefined

  function assign(groupId: number | null) {
    startTransition(async () => {
      await assignItemToGroup({ entityType, entityId, groupId })
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            disabled={isPending}
          />
        }
      >
        <FolderTree className="size-3.5" />
        {current ? current.name : label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel>Move to group</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => assign(null)}
          className={currentGroupId == null ? 'font-medium' : undefined}
        >
          Ungrouped
        </DropdownMenuItem>
        {flat.length > 0 && <DropdownMenuSeparator />}
        {flat.map((g) => (
          <DropdownMenuItem
            key={g.id}
            onClick={() => assign(g.id)}
            className={g.id === currentGroupId ? 'font-medium' : undefined}
          >
            <span style={{ paddingLeft: g.depth * 12 }}>{g.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Editor actions shown on a group header: add a subgroup, rename, or delete.
 */
export function GroupHeaderMenu({
  group,
  tree,
}: {
  group: GroupNode
  tree: GroupNode[]
}) {
  const [renaming, setRenaming] = useState(false)
  const [addingSub, setAddingSub] = useState(false)
  const [name, setName] = useState(group.name)
  const [isPending, startTransition] = useTransition()

  function submitRename() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      await renameGroup(group.id, trimmed)
      setRenaming(false)
    })
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteGroup(group.id)
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              aria-label={`Actions for ${group.name}`}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setName(group.name)
              setRenaming(true)
            }}
          >
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAddingSub(true)}>
            <FolderPlus className="size-4" />
            Add subgroup
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={handleDelete}>
            <Trash2 className="size-4" />
            Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename dialog */}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
            <DialogDescription>
              Update the name of “{group.name}”.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-1">
            <Label htmlFor={`rename-${group.id}`}>Group name</Label>
            <Input
              id={`rename-${group.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                  submitRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenaming(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={submitRename} disabled={isPending || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add subgroup dialog reuses NewGroupButton's flow via a controlled wrapper */}
      {addingSub && (
        <SubgroupDialog
          tree={tree}
          parentId={group.id}
          parentName={group.name}
          onClose={() => setAddingSub(false)}
        />
      )}
    </>
  )
}

// A minimal dialog to add a subgroup under a specific parent. Kept separate so
// the header menu can open it directly with the parent preselected.
function SubgroupDialog({
  parentId,
  parentName,
  onClose,
}: {
  tree: GroupNode[]
  parentId: number
  parentName: string
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  function submit() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      await createGroup({ name: trimmed, parentId })
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add subgroup</DialogTitle>
          <DialogDescription>
            Create a new group nested under “{parentName}”.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-1">
          <Label htmlFor="subgroup-name">Subgroup name</Label>
          <Input
            id="subgroup-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. Lubricants"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !name.trim()}>
            {isPending ? 'Creating…' : 'Create subgroup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
