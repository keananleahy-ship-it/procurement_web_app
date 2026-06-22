'use client'

import { useState, useTransition } from 'react'
import { createProduct, deleteProduct } from '@/app/actions/products'
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
import { Plus, Trash2, Package } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'

type Product = {
  id: number
  name: string
  category: string | null
  sku: string | null
  unit: string | null
  matchStatus: string
  canonicalItemName: string | null
}

export function ProductsView({ products }: { products: Product[] }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function handleCreate(formData: FormData) {
    await createProduct(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="size-4" />
            Add product
          </DialogTrigger>
          <DialogContent>
            <form action={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add product</DialogTitle>
                <DialogDescription>
                  A product is the item you collect vendor prices for. Group
                  similar offerings under one product to compare them.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Product name</Label>
                  <Input
                    id="name"
                    name="name"
                    required
                    placeholder="A4 Copy Paper, 80gsm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="category">Category</Label>
                    <Input id="category" name="category" placeholder="Office" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="unit">Unit</Label>
                    <Input id="unit" name="unit" placeholder="ream" />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" name="sku" placeholder="Optional" />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Save product</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add the products you purchase, then record vendor prices for each."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Canonical match</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium text-foreground">
                    {p.name}
                  </TableCell>
                  <TableCell>
                    {p.category ? (
                      <Badge variant="secondary">{p.category}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.unit ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.sku ?? '—'}
                  </TableCell>
                  <TableCell>
                    {p.matchStatus === 'confirmed' ? (
                      <Badge className="bg-success text-success-foreground hover:bg-success">
                        {p.canonicalItemName ?? 'Matched'}
                      </Badge>
                    ) : p.matchStatus === 'suggested' ? (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-amber-600 dark:text-amber-400"
                      >
                        Needs review
                      </Badge>
                    ) : p.matchStatus === 'rejected' ? (
                      <span className="text-muted-foreground">Rejected</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${p.name}`}
                      disabled={isPending}
                      onClick={() =>
                        startTransition(() => {
                          void deleteProduct(p.id)
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
