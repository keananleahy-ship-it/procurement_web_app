'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Upload,
  FileSpreadsheet,
  FileText,
  Download,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { formatDate } from '@/lib/format'
import { useCanEdit } from '@/components/role-provider'

type Option = { id: number; name: string }
type ImportRecord = {
  id: number
  fileName: string
  fileType: string
  blobPathname: string
  locationName: string | null
  effectiveDate: string | null
  status: string
  rowCount: number
  createdAt: string | Date
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-warning text-warning-foreground hover:bg-warning',
  committed: 'bg-success text-success-foreground hover:bg-success',
  discarded: '',
}

export function ImportsView({
  imports,
  locations,
  vendors,
}: {
  imports: ImportRecord[]
  locations: Option[]
  vendors: Option[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [vendorName, setVendorName] = useState('')
  // 'auto' lets the AI decide freight terms per row; any other value forces the
  // whole file to that basis (FOB origin / Delivered / Both).
  const [freightTerms, setFreightTerms] = useState('auto')
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10),
  )
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const canEdit = useCanEdit()

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('Please choose a file to upload.')
      return
    }
    const body = new FormData()
    body.set('file', file)
    body.set('effectiveDate', effectiveDate)
    if (locationId) body.set('locationId', locationId)
    if (vendorName.trim()) body.set('vendorName', vendorName.trim())
    if (freightTerms !== 'auto') body.set('freightTerms', freightTerms)

    setUploading(true)
    try {
      const res = await fetch('/api/imports', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Upload failed. Please try again.')
        return
      }
      setOpen(false)
      setFileName('')
      setVendorName('')
      setFreightTerms('auto')
      if (fileRef.current) fileRef.current.value = ''
      router.push(`/imports/${data.importId}`)
    } catch {
      setError('Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="p-6">
      {canEdit && (
      <div className="mb-4 flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button />}>
            <Upload className="size-4" />
            Upload price list
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleUpload}>
              <DialogHeader>
                <DialogTitle>Upload a price list</DialogTitle>
                <DialogDescription>
                  Upload an XLS, XLSX, CSV, or PDF file from a location. We use AI
                  to extract the line items, then you review them before anything
                  updates your pricing.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="file">File</Label>
                  <Input
                    ref={fileRef}
                    id="file"
                    name="file"
                    type="file"
                    accept=".xls,.xlsx,.csv,.pdf"
                    required
                    onChange={(e) =>
                      setFileName(e.target.files?.[0]?.name ?? '')
                    }
                  />
                  {fileName && (
                    <p className="text-xs text-muted-foreground">{fileName}</p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="vendorName">Vendor</Label>
                  <Input
                    id="vendorName"
                    name="vendorName"
                    list="vendor-suggestions"
                    placeholder="e.g. ALS, Shell, Phillips66"
                    value={vendorName}
                    onChange={(e) => setVendorName(e.target.value)}
                    autoComplete="off"
                  />
                  <datalist id="vendor-suggestions">
                    {vendors.map((v) => (
                      <option key={v.id} value={v.name} />
                    ))}
                  </datalist>
                  <p className="text-xs text-muted-foreground">
                    Applied to every line item we can&apos;t attribute to a
                    vendor automatically. You can still change individual rows
                    when reviewing.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Pricing terms</Label>
                  <Select
                    value={freightTerms}
                    onValueChange={(v) => setFreightTerms(v ?? 'auto')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      <SelectItem value="fob">FOB origin</SelectItem>
                      <SelectItem value="delivered">Delivered</SelectItem>
                      <SelectItem value="both">Both</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Whether this list is priced FOB origin, delivered, or both.
                    Leave on Auto-detect to read it from the document per line.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="effectiveDate">Effective date</Label>
                    <Input
                      id="effectiveDate"
                      type="date"
                      value={effectiveDate}
                      onChange={(e) => setEffectiveDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Location</Label>
                    <Select
                      value={locationId}
                      onValueChange={(v) => setLocationId(v ?? '')}
                    >
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
                </div>
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button type="submit" disabled={uploading}>
                  {uploading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Extracting…
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-4" />
                      Upload &amp; extract
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}

      {imports.length === 0 ? (
        <EmptyState
          icon={Upload}
          title="No uploads yet"
          description="Upload an XLS or PDF price list from a location. We'll extract the line items with AI so you can review and import them."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Effective date</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((imp) => (
                <TableRow key={imp.id}>
                  <TableCell className="font-medium text-foreground">
                    <span className="flex items-center gap-2">
                      {imp.fileType === 'pdf' ? (
                        <FileText className="size-4 text-muted-foreground" />
                      ) : (
                        <FileSpreadsheet className="size-4 text-muted-foreground" />
                      )}
                      <span className="max-w-[16rem] truncate">
                        {imp.fileName}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {imp.locationName ?? '—'}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {formatDate(imp.effectiveDate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {imp.rowCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={imp.status === 'discarded' ? 'secondary' : 'default'}
                      className={STATUS_STYLES[imp.status] ?? ''}
                    >
                      {imp.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(imp.createdAt as string)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={`/api/imports/file?pathname=${encodeURIComponent(
                          imp.blobPathname,
                        )}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={`Download ${imp.fileName}`}
                      >
                        <Download className="size-4" />
                      </a>
                      {canEdit && imp.status === 'pending' && (
                        <Button
                          variant="outline"
                          size="sm"
                          render={
                            <Link href={`/imports/${imp.id}`}>Review</Link>
                          }
                        />
                      )}
                    </div>
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
