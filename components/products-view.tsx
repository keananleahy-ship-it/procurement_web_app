'use client'

import { useMemo, useState, useTransition } from 'react'
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
import { Plus, Trash2, Package, Search } from 'lucide-react'
import { DataPagination } from '@/components/data-pagination'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'

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
  const canEdit = useCanEdit()

  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q) ||
        (p.sku ?? '').toLowerCase().includes(q) ||
        (p.canonicalItemName ?? '').toLowerCase().includes(q),
    )
  }, [products, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )

  async function handleCreate(formData: FormData) {
    await createProduct(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      {canEdit && (
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
      )}

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add the products you purchase, then record vendor prices for each."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border p-3">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(1)
                }}
                placeholder="Search name, category, SKU, or match"
                className="pl-9"
              />
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Canonical match</TableHead>
                {canEdit && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((p) => (
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
                  {canEdit && (
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
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No products match “{query}”.
            </p>
          ) : (
            <DataPagination
              page={currentPage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              label="products"
            />
          )}
        </div>
      )}
    </div>
  )
}
