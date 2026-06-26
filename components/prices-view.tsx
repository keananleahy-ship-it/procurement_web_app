'use client'

import { useMemo, useState, useTransition } from 'react'
import { createPrice, deletePrice } from '@/app/actions/prices'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { Plus, Trash2, Tags, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataPagination } from '@/components/data-pagination'
import { EmptyState } from '@/components/empty-state'
import { formatCurrency, formatDate } from '@/lib/format'
import { useCanEdit } from '@/components/role-provider'

type Option = { id: number; name: string }
type PriceRecord = {
  id: number
  productName: string
  vendorName: string
  locationName: string | null
  unitPrice: number
  shippingCost: number
  freightTerms: string
  deliveredPrice: number | null
  minOrderQty: number
  currency: string
  effectiveDate: string | null
}

const FREIGHT_LABELS: Record<string, string> = {
  fob: 'FOB origin',
  delivered: 'Delivered',
  both: 'FOB + Delivered',
}

export function PricesView({
  prices,
  products,
  vendors,
  locations,
}: {
  prices: PriceRecord[]
  products: Option[]
  vendors: Option[]
  locations: Option[]
}) {
  const [open, setOpen] = useState(false)
  const [productId, setProductId] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [freightTerms, setFreightTerms] = useState('fob')
  const [isPending, startTransition] = useTransition()
  const canEdit = useCanEdit()

  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return prices
    return prices.filter(
      (p) =>
        p.productName.toLowerCase().includes(q) ||
        p.vendorName.toLowerCase().includes(q) ||
        (p.locationName ?? '').toLowerCase().includes(q),
    )
  }, [prices, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )

  const canAdd = canEdit && products.length > 0 && vendors.length > 0
  const showShipping = freightTerms === 'fob' || freightTerms === 'both'
  const showDelivered = freightTerms === 'both'

  async function handleCreate(formData: FormData) {
    await createPrice(formData)
    setOpen(false)
    setProductId('')
    setVendorId('')
    setLocationId('')
    setFreightTerms('fob')
  }

  return (
    <div className="p-6">
      {canEdit && (
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button disabled={!canAdd} />}>
            <Plus className="size-4" />
            Add price
          </DialogTrigger>
          <DialogContent>
            <form action={handleCreate}>
              <DialogHeader>
                <DialogTitle>Record a vendor price</DialogTitle>
                <DialogDescription>
                  Capture what a vendor charges for a product at a location.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label>Product</Label>
                  <input type="hidden" name="productId" value={productId} />
                  <Select value={productId} onValueChange={setProductId} required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Vendor</Label>
                  <input type="hidden" name="vendorId" value={vendorId} />
                  <Select value={vendorId} onValueChange={setVendorId} required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((v) => (
                        <SelectItem key={v.id} value={String(v.id)}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Location</Label>
                  <input type="hidden" name="locationId" value={locationId} />
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Optional" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Freight terms</Label>
                  <input
                    type="hidden"
                    name="freightTerms"
                    value={freightTerms}
                  />
                  <Select
                    value={freightTerms}
                    onValueChange={setFreightTerms}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(value: string) => FREIGHT_LABELS[value] ?? value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fob">
                        FOB origin — buyer pays freight
                      </SelectItem>
                      <SelectItem value="delivered">
                        Delivered — price includes freight
                      </SelectItem>
                      <SelectItem value="both">
                        Both — FOB price and a delivered price
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {freightTerms === 'fob' &&
                      'Enter freight per unit; it is added on top of the unit price as landed cost.'}
                    {freightTerms === 'delivered' &&
                      'The unit price is all-in; no freight is added in the analysis.'}
                    {freightTerms === 'both' &&
                      'We compare the FOB landed cost against the delivered price and use whichever is cheaper.'}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="unitPrice">
                      {freightTerms === 'delivered'
                        ? 'Delivered unit price'
                        : 'FOB unit price'}
                    </Label>
                    <Input
                      id="unitPrice"
                      name="unitPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      placeholder="0.00"
                    />
                  </div>
                  {showShipping && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="shippingCost">Freight / unit</Label>
                      <Input
                        id="shippingCost"
                        name="shippingCost"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue="0"
                        placeholder="Per unit"
                      />
                    </div>
                  )}
                  {showDelivered && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="deliveredPrice">
                        Delivered unit price
                      </Label>
                      <Input
                        id="deliveredPrice"
                        name="deliveredPrice"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="minOrderQty">Min order qty</Label>
                    <Input
                      id="minOrderQty"
                      name="minOrderQty"
                      type="number"
                      min="1"
                      defaultValue="1"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Input id="currency" name="currency" defaultValue="USD" />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={!productId || !vendorId}>
                  Save price
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}

      {canEdit && !canAdd && (
        <p className="mb-4 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          Add at least one product and one vendor before recording prices.
        </p>
      )}

      {prices.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No price entries yet"
          description="Record what each vendor charges to start comparing acquisition costs."
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
                placeholder="Search product, vendor, or location"
                className="pl-9"
              />
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Freight</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Freight / unit</TableHead>
                <TableHead className="text-right">Min qty</TableHead>
                <TableHead>Effective</TableHead>
                {canEdit && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium text-foreground">
                    {p.productName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.vendorName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.locationName ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal">
                      {FREIGHT_LABELS[p.freightTerms] ?? p.freightTerms}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-foreground">
                    {formatCurrency(p.unitPrice, p.currency)}
                    {p.freightTerms === 'both' &&
                      p.deliveredPrice !== null && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {formatCurrency(p.deliveredPrice, p.currency)} delv.
                        </span>
                      )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {p.freightTerms === 'delivered'
                      ? 'incl.'
                      : formatCurrency(p.shippingCost, p.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {p.minOrderQty}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {formatDate(p.effectiveDate)}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete price entry"
                        disabled={isPending}
                        onClick={() =>
                          startTransition(() => {
                            void deletePrice(p.id)
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
              No price entries match “{query}”.
            </p>
          ) : (
            <DataPagination
              page={currentPage}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onPageChange={setPage}
              label="price entries"
            />
          )}
        </div>
      )}
    </div>
  )
}
