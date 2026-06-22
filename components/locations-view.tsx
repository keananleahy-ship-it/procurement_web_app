'use client'

import { useState, useTransition } from 'react'
import { createLocation, deleteLocation } from '@/app/actions/locations'
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
import { Plus, Trash2, MapPin } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

type Location = {
  id: number
  name: string
  region: string | null
}

export function LocationsView({ locations }: { locations: Location[] }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function handleCreate(formData: FormData) {
    await createLocation(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="size-4" />
              Add location
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form action={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add location</DialogTitle>
                <DialogDescription>
                  Locations let you compare acquisition costs across sites.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Location name</Label>
                  <Input id="name" name="name" required placeholder="Chicago Warehouse" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="region">Region</Label>
                  <Input id="region" name="region" placeholder="Midwest" />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Save location</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {locations.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet"
          description="Add locations to compare acquisition costs across your sites."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Region</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium text-foreground">
                    {l.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.region ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${l.name}`}
                      disabled={isPending}
                      onClick={() =>
                        startTransition(() => {
                          void deleteLocation(l.id)
                        })
                      }
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
