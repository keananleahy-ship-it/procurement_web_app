'use client'

import { useState, useTransition } from 'react'
import { createVendor, deleteVendor, mergeVendorNames } from '@/app/actions/vendors'
import type { VendorVariantGroup } from '@/lib/vendors-registry'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Plus, Trash2, Store, Merge } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'

type Vendor = {
  id: number
  name: string
  contactEmail: string | null
  notes: string | null
}

// Offers to consolidate supplier spellings that mean the same vendor. Kept as
// an explicit action rather than an automatic cleanup, because it rewrites
// existing product rows.
function VariantMergePanel({ groups }: { groups: VendorVariantGroup[] }) {
  const [isPending, startTransition] = useTransition()
  const [done, setDone] = useState<Record<string, number>>({})

  const remaining = groups.filter((g) => done[g.key] === undefined)

  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-2">
        <Merge className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">
            Duplicate supplier spellings
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            These product records use different spellings of the same vendor.
            Merging rewrites them to the vendor&apos;s canonical name so the
            vendor list and price comparisons stay consolidated.
          </p>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {remaining.map((g) => (
          <li
            key={g.key}
            className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-foreground">
                {g.canonicalName}
              </span>
              <span className="text-muted-foreground">
                {g.variants
                  .map((v) => `"${v.supplier}" (${v.productCount})`)
                  .join(', ')}
                {' → '}
                {`"${g.canonicalName}"`}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const r = await mergeVendorNames(g.key, g.canonicalName)
                  setDone((d) => ({ ...d, [g.key]: r.updated }))
                })
              }
            >
              {`Merge ${g.affectedProducts} ${g.affectedProducts === 1 ? 'product' : 'products'}`}
            </Button>
          </li>
        ))}
      </ul>

      {Object.entries(done).map(([key, n]) => (
        <p key={key} className="mt-2 text-xs text-muted-foreground">
          {`Merged ${n} ${n === 1 ? 'product' : 'products'}.`}
        </p>
      ))}
    </div>
  )
}

export function VendorsView({
  vendors,
  variantGroups = [],
}: {
  vendors: Vendor[]
  variantGroups?: VendorVariantGroup[]
}) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const canEdit = useCanEdit()

  async function handleCreate(formData: FormData) {
    await createVendor(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      {canEdit && variantGroups.length > 0 && (
        <VariantMergePanel groups={variantGroups} />
      )}
      {canEdit && (
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="size-4" />
            Add vendor
          </DialogTrigger>
          <DialogContent>
            <form action={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add vendor</DialogTitle>
                <DialogDescription>
                  Add a supplier you want to compare pricing against.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Vendor name</Label>
                  <Input id="name" name="name" required placeholder="Acme Supply Co." />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="contactEmail">Contact email</Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    placeholder="sales@acme.com"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Input id="notes" name="notes" placeholder="Optional notes" />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Save vendor</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}

      {vendors.length === 0 ? (
        <EmptyState
          icon={Store}
          title="No vendors yet"
          description="Add your first vendor to start tracking and comparing prices."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Notes</TableHead>
                {canEdit && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium text-foreground">
                    {v.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {v.contactEmail ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {v.notes ?? '—'}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${v.name}`}
                        disabled={isPending}
                        onClick={() =>
                          startTransition(() => {
                            void deleteVendor(v.id)
                          })
                        }
                      >
                        <Trash2 className="size-4 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
