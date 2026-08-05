'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  createProduct,
  deleteProduct,
  updateProductAttribute,
} from '@/app/actions/products'
import { assignMatch, resetMatch } from '@/app/actions/canonical'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2, Package, Search, RotateCcw } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'
import {
  AttributeGroupedList,
  type GroupItem,
} from '@/components/attribute-grouped-list'
import { AttributeEditor } from '@/components/attribute-editor'
import {
  PRODUCT_ATTRIBUTES,
  PRODUCT_DEFAULT_GROUP_BY,
  type AttributeKey,
} from '@/lib/attributes'

type CanonicalOption = { id: number; name: string }

type Product = {
  id: number
  name: string
  brand: string | null
  category: string | null
  application: string | null
  subcategory: string | null
  viscosity: string | null
  packageType: string | null
  supplier: string | null
  sku: string | null
  unit: string | null
  matchStatus: string
  canonicalItemId: number | null
  canonicalItemName: string | null
}

// Inline canonical-match editor for a single product row. Reuses the same
// server actions as the Matching page: assignMatch links + confirms to a
// canonical item, resetMatch unlinks it back to unmatched.
function MatchEditor({
  product,
  canonicalItems,
}: {
  product: Product
  canonicalItems: CanonicalOption[]
}) {
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex items-center gap-2">
      <Select
        disabled={isPending || canonicalItems.length === 0}
        value=""
        onValueChange={(v) =>
          startTransition(() => {
            void assignMatch(product.id, Number(v))
          })
        }
      >
        <SelectTrigger className="h-8 w-48 text-xs">
          <SelectValue
            placeholder={
              product.matchStatus === 'confirmed'
                ? 'Change match'
                : 'Assign match'
            }
          />
        </SelectTrigger>
        <SelectContent>
          {canonicalItems.map((c) => (
            <SelectItem key={c.id} value={String(c.id)} className="text-xs">
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {product.canonicalItemId !== null && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Clear match for ${product.name}`}
          disabled={isPending}
          onClick={() =>
            startTransition(() => {
              void resetMatch(product.id)
            })
          }
        >
          <RotateCcw className="size-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  )
}

// Renders a table for a bucket of products. Shared by every group section so
// each group shows its own products with the same columns.
function ProductTable({
  products,
  canonicalItems,
  canEdit,
}: {
  products: Product[]
  canonicalItems: CanonicalOption[]
  canEdit: boolean
}) {
  const [isPending, startTransition] = useTransition()

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Canonical match</TableHead>
            {canEdit && <TableHead className="w-20 text-right">Edit</TableHead>}
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
                <div className="flex flex-col gap-1.5">
                  {p.matchStatus === 'confirmed' ? (
                    <Badge className="w-fit bg-success text-success-foreground hover:bg-success">
                      {p.canonicalItemName ?? 'Matched'}
                    </Badge>
                  ) : p.matchStatus === 'suggested' ? (
                    <Badge
                      variant="outline"
                      className="w-fit border-amber-500/40 text-amber-600 dark:text-amber-400"
                    >
                      Needs review
                    </Badge>
                  ) : p.matchStatus === 'rejected' ? (
                    <span className="text-sm text-muted-foreground">
                      Rejected
                    </span>
                  ) : p.matchStatus === 'excluded' ? (
                    <span className="text-sm text-muted-foreground">
                      Excluded
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Unmatched
                    </span>
                  )}
                  {canEdit && (
                    <MatchEditor product={p} canonicalItems={canonicalItems} />
                  )}
                </div>
              </TableCell>
              {canEdit && (
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <AttributeEditor
                      editable={PRODUCT_ATTRIBUTES}
                      label={p.name}
                      values={{
                        supplier: p.supplier,
                        brand: p.brand,
                        category: p.category,
                        application: p.application,
                        subcategory: p.subcategory,
                        viscosity: p.viscosity,
                        packageType: p.packageType,
                      }}
                      onSave={(key, value) =>
                        updateProductAttribute(p.id, key, value)
                      }
                    />
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
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ProductsView({
  products,
  canonicalItems,
}: {
  products: Product[]
  canonicalItems: CanonicalOption[]
}) {
  const [open, setOpen] = useState(false)
  const canEdit = useCanEdit()
  const [query, setQuery] = useState('')

  // Map each product to a GroupItem the hierarchy component can nest + count.
  // The node is a single-row table so every group renders the familiar layout.
  const groupItems = useMemo<GroupItem[]>(
    () =>
      products.map((p) => ({
        id: String(p.id),
        attributes: {
          supplier: p.supplier,
          brand: p.brand,
          category: p.category,
          application: p.application,
          subcategory: p.subcategory,
          viscosity: p.viscosity,
          packageType: p.packageType,
        },
        searchText: [p.name, p.brand, p.category, p.sku, p.canonicalItemName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        node: (
          <ProductTable
            products={[p]}
            canonicalItems={canonicalItems}
            canEdit={canEdit}
          />
        ),
      })),
    [products, canonicalItems, canEdit],
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
                      <Input
                        id="category"
                        name="category"
                        placeholder="Office"
                      />
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
        <div className="flex flex-col gap-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, category, SKU, or match"
              className="pl-9"
            />
          </div>

          <AttributeGroupedList
            items={groupItems}
            available={PRODUCT_ATTRIBUTES}
            defaultGroupBy={PRODUCT_DEFAULT_GROUP_BY}
            storageKey="products-v2"
            query={query}
            itemLabel="products"
          />
        </div>
      )}
    </div>
  )
}
