'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCanEdit } from '@/components/role-provider'
import { reassignWarehouse, type WarehouseRow } from '@/app/actions/warehouses'

type Option = { id: number; name: string }

const gal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

export function WarehouseAssignments({
  warehouses,
  locations,
}: {
  warehouses: WarehouseRow[]
  locations: Option[]
}) {
  const router = useRouter()
  const canEdit = useCanEdit()
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  if (warehouses.length === 0) return null

  const totals = new Map<number, number>()
  for (const w of warehouses) {
    totals.set(w.locationId, (totals.get(w.locationId) ?? 0) + w.gallons)
  }

  function handleChange(id: number, locationId: number) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      try {
        await reassignWarehouse(id, locationId)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not reassign warehouse.')
      } finally {
        setPendingId(null)
      }
    })
  }

  return (
    <section aria-labelledby="warehouses-heading" className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="warehouses-heading" className="text-base font-semibold">
            Warehouses
          </h2>
          <p className="text-sm text-muted-foreground">
            Consolidated purchase history, trailing 12 months. Each warehouse
            rolls up to one main location for Savings, Compare and Catalog
            Validation.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {locations
            .filter((l) => totals.has(l.id))
            .map((l) => `${l.name}: ${gal.format(totals.get(l.id) ?? 0)} gal`)
            .join(' · ')}
        </p>
      </div>
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Region</TableHead>
              <TableHead className="text-right">Products</TableHead>
              <TableHead className="text-right">Gallons</TableHead>
              <TableHead className="text-right">Avg $/gal</TableHead>
              <TableHead>Rolls up to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {warehouses.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="font-medium">{w.company}</TableCell>
                <TableCell>{w.code}</TableCell>
                <TableCell className="text-muted-foreground">
                  {w.region ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {w.products}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {gal.format(w.gallons)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {w.gallons > 0 ? usd.format(w.cost / w.gallons) : '—'}
                </TableCell>
                <TableCell>
                  <select
                    aria-label={`Main location for ${w.company} ${w.code}`}
                    className="h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-60"
                    value={w.locationId}
                    disabled={!canEdit || pendingId !== null}
                    onChange={(e) => handleChange(w.id, Number(e.target.value))}
                  >
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  {pendingId === w.id && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      Updating…
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
