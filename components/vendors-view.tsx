'use client'

import { useState, useTransition } from 'react'
import { createVendor, deleteVendor } from '@/app/actions/vendors'
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
import { Plus, Trash2, Store } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'

type Vendor = {
  id: number
  name: string
  contactEmail: string | null
  notes: string | null
}

export function VendorsView({ vendors }: { vendors: Vendor[] }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const canEdit = useCanEdit()

  async function handleCreate(formData: FormData) {
    await createVendor(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
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
