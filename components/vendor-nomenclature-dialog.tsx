'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  getVendorTokens,
  upsertVendorToken,
  deleteVendorToken,
} from '@/app/actions/vendor-nomenclature'
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
import { Badge } from '@/components/ui/badge'
import { BookA, Plus, Trash2 } from 'lucide-react'

type TokenKind = 'unit' | 'separator' | 'container' | 'unit_class'

type TokenRow = {
  id: number
  token: string
  kind: string
  value: string
  source: string
  confirmations: number
}

// Human-friendly guidance for each token kind, shown next to the value field.
const KIND_HELP: Record<TokenKind, { label: string; placeholder: string }> = {
  unit: { label: 'Unit alias', placeholder: 'canonical unit, e.g. gal' },
  separator: { label: 'Pack separator', placeholder: 'e.g. *' },
  container: { label: 'Fixed container', placeholder: 'capacity in gallons, e.g. 6' },
  unit_class: {
    label: 'Force unit class',
    placeholder: 'volume | weight | each',
  },
}

export function VendorNomenclatureDialog({
  vendorId,
  vendorName,
  canEdit,
}: {
  vendorId: number
  vendorName: string
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loading, setLoading] = useState(false)
  const [isPending, startTransition] = useTransition()

  // New-row form state
  const [token, setToken] = useState('')
  const [kind, setKind] = useState<TokenKind>('unit')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getVendorTokens(vendorId)
      .then((rows) => setTokens(rows as TokenRow[]))
      .finally(() => setLoading(false))
  }, [open, vendorId])

  function refresh() {
    getVendorTokens(vendorId).then((rows) => setTokens(rows as TokenRow[]))
  }

  function handleAdd() {
    if (!token.trim() || !value.trim()) return
    startTransition(async () => {
      await upsertVendorToken({ vendorId, token, kind, value })
      setToken('')
      setValue('')
      refresh()
    })
  }

  function handleDelete(id: number) {
    startTransition(async () => {
      await deleteVendorToken(id)
      refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={`Edit nomenclature for ${vendorName}`} />
        }
      >
        <BookA className="size-4 text-muted-foreground" />
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{vendorName} — nomenclature</DialogTitle>
          <DialogDescription>
            How this vendor writes sizes and units. The system learns these
            automatically from your import review corrections; manual entries
            here always take precedence.
          </DialogDescription>
        </DialogHeader>

        {canEdit && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="e.g. ugl"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kind">Meaning</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as TokenKind)}>
                <SelectTrigger id="kind" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unit">Unit alias</SelectItem>
                  <SelectItem value="separator">Pack separator</SelectItem>
                  <SelectItem value="container">Fixed container</SelectItem>
                  <SelectItem value="unit_class">Force unit class</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="value">Value</Label>
              <Input
                id="value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={KIND_HELP[kind].placeholder}
              />
            </div>
            <Button onClick={handleAdd} disabled={isPending || !token.trim() || !value.trim()}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Meaning</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Source</TableHead>
                {canEdit && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : tokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No learned or custom tokens yet. Built-in industry tokens
                    still apply.
                  </TableCell>
                </TableRow>
              ) : (
                tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono font-medium text-foreground">
                      {t.token}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {KIND_HELP[t.kind as TokenKind]?.label ?? t.kind}
                    </TableCell>
                    <TableCell className="font-mono text-foreground">
                      {t.value}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          t.source === 'manual'
                            ? 'border-primary/40 text-primary'
                            : 'border-border text-muted-foreground'
                        }
                      >
                        {t.source}
                        {t.source === 'learned' && t.confirmations > 1
                          ? ` ×${t.confirmations}`
                          : ''}
                      </Badge>
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete token ${t.token}`}
                          disabled={isPending}
                          onClick={() => handleDelete(t.id)}
                        >
                          <Trash2 className="size-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}
