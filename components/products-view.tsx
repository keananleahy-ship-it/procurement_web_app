'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  createProduct,
  deleteProduct,
  updateProductAttribute,
} from '@/app/actions/products'
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
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Package,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/empty-state'
import { useCanEdit } from '@/components/role-provider'
import { AttributeEditor } from '@/components/attribute-editor'
import {
  ProductFilterBar,
  type ActiveFilter,
  type FilterDef,
} from '@/components/product-filter-bar'
import { PRODUCT_ATTRIBUTES, emptyLabelFor } from '@/lib/attributes'
import type { ProductListRow } from '@/lib/product-list'

const FILTER_DEFS: FilterDef[] = [
  { key: 'location', label: 'Location', emptyLabel: 'No location' },
  ...PRODUCT_ATTRIBUTES.map((a) => ({
    key: a.key,
    label: a.label,
    emptyLabel: emptyLabelFor(a.key),
  })),
]
const DEFAULT_FILTERS: ActiveFilter[] = [
  { key: 'category', values: [] },
  { key: 'viscosity', values: [] },
  { key: 'location', values: [] },
]
const STORAGE_KEY = 'products-filters:v1'
const PAGE_SIZE = 100

type SortKey = 'name' | 'location' | 'volume' | 'price'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

const valueOf = (row: ProductListRow, key: string): string | null => {
  const v = row[key as keyof ProductListRow]
  return v == null || v === '' ? null : String(v)
}

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
})
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function matches(
  row: ProductListRow,
  filters: ActiveFilter[],
  skipKey?: string,
): boolean {
  for (const f of filters) {
    if (f.key === skipKey || f.values.length === 0) continue
    const def = FILTER_DEFS.find((d) => d.key === f.key)
    const v = valueOf(row, f.key) ?? def?.emptyLabel ?? ''
    if (!f.values.includes(v)) return false
  }
  return true
}

function compareRows(a: ProductListRow, b: ProductListRow, sort: Sort) {
  const dir = sort.dir === 'asc' ? 1 : -1
  if (sort.key === 'volume' || sort.key === 'price') {
    const field = sort.key === 'volume' ? 'volume' : 'pricePerBaseUnit'
    const av = a[field]
    const bv = b[field]
    // Missing values always sink to the bottom.
    if (av == null && bv == null) return a.name.localeCompare(b.name)
    if (av == null) return 1
    if (bv == null) return -1
    return (av - bv) * dir || a.name.localeCompare(b.name)
  }
  const av = (sort.key === 'name' ? a.name : a.location) ?? ''
  const bv = (sort.key === 'name' ? b.name : b.location) ?? ''
  if (!av && bv) return 1
  if (av && !bv) return -1
  return av.localeCompare(bv, undefined, { numeric: true }) * dir
}

export function ProductsView({ rows }: { rows: ProductListRow[] }) {
  const canEdit = useCanEdit()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ActiveFilter[]>(DEFAULT_FILTERS)
  const [hydrated, setHydrated] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'volume', dir: 'desc' })
  const [limit, setLimit] = useState(PAGE_SIZE)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ActiveFilter[]
        if (Array.isArray(parsed)) {
          setFilters(
            parsed.filter(
              (f) =>
                FILTER_DEFS.some((d) => d.key === f.key) &&
                Array.isArray(f.values),
            ),
          )
        }
      }
    } catch {
      // ignore malformed storage
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters))
    } catch {
      // storage unavailable
    }
  }, [filters, hydrated])

  const q = query.trim().toLowerCase()
  const searched = useMemo(
    () =>
      q
        ? rows.filter((r) =>
            [r.name, r.sku, r.brand, r.supplier, r.performanceSpec]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q),
          )
        : rows,
    [rows, q],
  )

  const rowsExcept = useCallback(
    (key: string) => searched.filter((r) => matches(r, filters, key)),
    [searched, filters],
  )

  const visible = useMemo(
    () =>
      searched
        .filter((r) => matches(r, filters))
        .sort((a, b) => compareRows(a, b, sort)),
    [searched, filters, sort],
  )

  useEffect(() => setLimit(PAGE_SIZE), [filters, q, sort])

  const productCount = useMemo(
    () => new Set(visible.map((r) => r.productId)).size,
    [visible],
  )

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'volume' ? 'desc' : 'asc' },
    )
  }

  async function handleCreate(formData: FormData) {
    await createProduct(formData)
    setOpen(false)
  }

  return (
    <div className="p-6">
      {rows.length === 0 ? (
        <>
          {canEdit && (
            <div className="mb-4 flex justify-end">
              <AddProductDialog open={open} setOpen={setOpen} onSubmit={handleCreate} />
            </div>
          )}
          <EmptyState
            icon={Package}
            title="No products yet"
            description="Add the products you purchase, then record vendor prices for each."
          />
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, SKU, brand, or spec"
                aria-label="Search products"
                className="pl-9"
              />
            </div>
            {canEdit && (
              <div className="ml-auto">
                <AddProductDialog open={open} setOpen={setOpen} onSubmit={handleCreate} />
              </div>
            )}
          </div>

          <ProductFilterBar
            defs={FILTER_DEFS}
            filters={filters}
            onChange={setFilters}
            rows={searched}
            valueOf={valueOf}
            rowsExcept={rowsExcept}
          />

          <p className="text-sm text-muted-foreground" aria-live="polite">
            {qty.format(productCount)} products across{' '}
            {qty.format(visible.length)} location rows
          </p>

          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No products match your filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Product" k="name" sort={sort} onSort={toggleSort} />
                    <SortHead label="Location" k="location" sort={sort} onSort={toggleSort} />
                    <SortHead label="R12 volume" k="volume" sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="Price" k="price" sort={sort} onSort={toggleSort} align="right" />
                    {canEdit && <TableHead className="w-20 text-right">Edit</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.slice(0, limit).map((r) => (
                    <ProductRow key={r.key} row={r} canEdit={canEdit} />
                  ))}
                </TableBody>
              </Table>
              {visible.length > limit && (
                <div className="flex items-center justify-center gap-3 border-t border-border p-3">
                  <span className="text-sm text-muted-foreground">
                    Showing {qty.format(limit)} of {qty.format(visible.length)}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE * 2)}>
                    Show more
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  align,
}: {
  label: string
  k: SortKey
  sort: Sort
  onSort: (k: SortKey) => void
  align?: 'right'
}) {
  const active = sort.key === k
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead
      className={cn(align === 'right' && 'text-right')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    </TableHead>
  )
}

function ProductRow({ row: r, canEdit }: { row: ProductListRow; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition()
  const tags = [r.category, r.viscosity, r.subcategory, r.packageType, r.supplier].filter(Boolean)
  const unit = r.baseUnit ?? r.volumeUnit

  return (
    <TableRow>
      <TableCell className="max-w-md whitespace-normal">
        <div className="font-medium text-foreground">{r.name}</div>
        {tags.length > 0 && (
          <div className="mt-0.5 text-xs text-muted-foreground">{tags.join(' · ')}</div>
        )}
      </TableCell>
      <TableCell>
        {r.location ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums" title={r.volumePeriod ? `Source period: ${r.volumePeriod}` : undefined}>
        {r.volume != null ? (
          <>
            {qty.format(r.volume)}
            {r.volumeUnit && <span className="ml-1 text-xs text-muted-foreground">{r.volumeUnit}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {r.pricePerBaseUnit != null ? (
          <div title={r.priceDate ? `Effective ${r.priceDate}` : undefined}>
            <div>
              {money.format(r.pricePerBaseUnit)}
              {unit && <span className="text-xs text-muted-foreground">/{unit}</span>}
            </div>
            {r.price != null && r.price !== r.pricePerBaseUnit && (
              <div className="text-xs text-muted-foreground">
                {money.format(r.price)}
                {r.unit ? ` / ${r.unit}` : ' / pack'}
              </div>
            )}
          </div>
        ) : r.paidPerBaseUnit != null ? (
          <div className="text-muted-foreground">
            {money.format(r.paidPerBaseUnit)}
            {unit && <span className="text-xs">/{unit}</span>}
            <div className="text-xs">paid, no quote</div>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      {canEdit && (
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <AttributeEditor
              editable={PRODUCT_ATTRIBUTES}
              label={r.name}
              values={{
                supplier: r.supplier,
                brand: r.brand,
                category: r.category,
                application: r.application,
                subcategory: r.subcategory,
                viscosity: r.viscosity,
                packageType: r.packageType,
                performanceSpec: r.performanceSpec,
              }}
              onSave={(key, value) => updateProductAttribute(r.productId, key, value)}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${r.name}`}
              disabled={isPending}
              onClick={() =>
                startTransition(() => {
                  void deleteProduct(r.productId)
                })
              }
            >
              <Trash2 className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </TableCell>
      )}
    </TableRow>
  )
}

function AddProductDialog({
  open,
  setOpen,
  onSubmit,
}: {
  open: boolean
  setOpen: (o: boolean) => void
  onSubmit: (fd: FormData) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" />
        Add product
      </DialogTrigger>
      <DialogContent>
        <form action={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add product</DialogTitle>
            <DialogDescription>
              A product is the item you collect vendor prices for.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Product name</Label>
              <Input id="name" name="name" required placeholder="Delo 400 SDE 15W-40, 55 gal drum" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="category">Category</Label>
                <Input id="category" name="category" placeholder="Engine Oil" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="unit">Unit</Label>
                <Input id="unit" name="unit" placeholder="drum" />
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
  )
}
