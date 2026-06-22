'use client'

import { useState, useTransition } from 'react'
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
import { Plus, Trash2, Tags } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { formatCurrency } from '@/lib/format'

type Option = { id: number; name: string }
type PriceRecord = {
  id: number
  productName: string
  vendorName: string
  locationName: string | null
  unitPrice: number
  shippingCost: number
  minOrderQty: number
  currency: string
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
  const [isPending, startTransition] = useTransition()

  const canAdd = products.length > 0 && vendors.length > 0

  async function handleCreate(formData: FormData) {
    await createPrice(formData)
    setOpen(false)
    setProductId('')
    setVendorId('')
    setLocationId('')
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={!canAdd}>
              <Plus className="size-4" />
              Add price
            </Button>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="unitPrice">Unit price</Label>
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
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="shippingCost">Shipping cost</Label>
                    <Input
                      id="shippingCost"
                      name="shippingCost"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue="0"
                    />
                  </div>
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

      {!canAdd && (
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Shipping</TableHead>
                <TableHead className="text-right">Min qty</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.map((p) => (
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
                  <TableCell className="text-right tabular-nums text-foreground">
                    {formatCurrency(p.unitPrice, p.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCurrency(p.shippingCost, p.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {p.minOrderQty}
                  </TableCell>
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
