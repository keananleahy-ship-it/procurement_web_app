'use client'

import { useState, useTransition } from 'react'
import {
  createCanonicalItem,
  deleteCanonicalItem,
} from '@/app/actions/canonical'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
import { Plus, Trash2, Layers } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

type CanonicalItem = {
  id: number
  name: string
  category: string | null
  unit: string | null
  baseUnit: string | null
  matchedCount: number
}

export function CanonicalView({ items }: { items: CanonicalItem[] }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function handleCreate(formData: FormData) {
    await createCanonicalItem(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="size-4" />
            Add canonical item
          </DialogTrigger>
          <DialogContent>
            <form action={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add canonical item</DialogTitle>
                <DialogDescription>
                  A canonical item is the master definition that vendor-specific
                  products get matched to, so differently-named offerings compare
                  as one.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Canonical name</Label>
                  <Input
                    id="name"
                    name="name"
                    required
                    placeholder="Copy Paper, A4 80gsm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="category">Category</Label>
                    <Input id="category" name="category" placeholder="Office" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="unit">Selling unit</Label>
                    <Input id="unit" name="unit" placeholder="ream" />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="baseUnit">Base unit (for comparison)</Label>
                  <Input
                    id="baseUnit"
                    name="baseUnit"
                    placeholder="sheet"
                  />
                  <p className="text-xs text-muted-foreground">
                    Prices are normalized to this unit so different pack sizes
                    compare fairly (e.g. compare per sheet, per litre, per each).
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Save canonical item</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No canonical items yet"
          description="Define the master items you want to compare against, then run matching to link vendor products to them."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Canonical item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Selling unit</TableHead>
                <TableHead>Base unit</TableHead>
                <TableHead className="text-right">Matched products</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id}>
                  <TableCell className="font-medium text-foreground">
                    {it.name}
                  </TableCell>
                  <TableCell>
                    {it.category ? (
                      <Badge variant="secondary">{it.category}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {it.unit ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {it.baseUnit ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {it.matchedCount > 0 ? (
                      <Badge className="bg-success text-success-foreground hover:bg-success">
                        {it.matchedCount}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${it.name}`}
                      disabled={isPending}
                      onClick={() =>
                        startTransition(() => {
                          void deleteCanonicalItem(it.id)
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
