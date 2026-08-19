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
import {
  resyncCommittedVolumeImport,
  reassignVolumeImportLocation,
} from '@/app/actions/volumes'
import { RefreshCw, MapPin, Check } from 'lucide-react'

// Lets an editor correct the location a whole upload is attributed to. For a
// committed import this physically moves the volumes it wrote to the new
// location, so the change is confirmed in a dialog that spells that out.
function LocationCell({
  imp,
  locations,
}: {
  imp: VolumeImportRecord
  locations: Option[]
}) {
  const router = useRouter()
  const canEdit = useCanEdit()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(imp.locationId ? String(imp.locationId) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canEdit || imp.status === 'discarded') {
    return (
      <span className="text-foreground">{imp.locationName ?? '—'}</span>
    )
  }

  async function handleSave() {
    if (!value) {
      setError('Choose a location.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await reassignVolumeImportLocation(imp.id, Number(value))
      setOpen(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reassign location.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setValue(imp.locationId ? String(imp.locationId) : '')
          setError(null)
        }
      }}
    >
      <DialogTrigger
        render={
          <button
            type="button"
            className="group inline-flex items-center gap-1.5 rounded-md text-left text-foreground transition-colors hover:text-primary"
            title="Reassign this upload to a different location"
          />
        }
      >
        <span>{imp.locationName ?? 'Set location'}</span>
        <MapPin className="size-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign location</DialogTitle>
          <DialogDescription>
            {imp.status === 'committed'
              ? 'This upload is committed. Changing its location moves the purchase volumes it applied — they stop weighting the old location and start weighting the new one.'
              : 'Choose the location this uploaded purchasing data belongs to.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-4">
          <Label>Location</Label>
          <Select
            value={value}
            onValueChange={(v) => setValue(v ?? '')}
            items={Object.fromEntries(
              locations.map((l) => [String(l.id), l.name]),
            )}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || value === String(imp.locationId ?? '')}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Save location
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Option = { id: number; name: string }
type VolumeImportRecord = {
  id: number
  fileName: string
  fileType: string
  blobPathname: string
  locationId: number | null
  locationName: string | null
  defaultPeriod: string | null
  status: string
  rowCount: number
  createdAt: string | Date
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-warning text-warning-foreground hover:bg-warning',
  committed: 'bg-success text-success-foreground hover:bg-success',
  discarded: '',
}

export function VolumesView({
  volumeImports,
  locations,
}: {
  volumeImports: VolumeImportRecord[]
  locations: Option[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [defaultPeriod, setDefaultPeriod] = useState('')
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const canEdit = useCanEdit()
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [syncMsg, setSyncMsg] = useState<{ id: number; text: string } | null>(
    null,
  )

  async function handleResync(id: number) {
    setSyncingId(id)
    setSyncMsg(null)
    try {
      const res = await resyncCommittedVolumeImport(id)
      setSyncMsg({
        id,
        text: `Synced ${res.committed} matched ${
          res.committed === 1 ? 'item' : 'items'
        } to comparisons.`,
      })
      router.refresh()
    } catch (e) {
      setSyncMsg({
        id,
        text: e instanceof Error ? e.message : 'Re-sync failed.',
      })
    } finally {
      setSyncingId(null)
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('Please choose a file to upload.')
      return
    }
    if (!locationId) {
      setError('Please choose the location this purchasing data belongs to.')
      return
    }
    const body = new FormData()
    body.set('file', file)
    body.set('locationId', locationId)
    if (defaultPeriod.trim()) body.set('defaultPeriod', defaultPeriod.trim())

    setUploading(true)
    try {
      const res = await fetch('/api/volumes', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Upload failed. Please try again.')
        return
      }
      setOpen(false)
      setFileName('')
      setDefaultPeriod('')
      if (fileRef.current) fileRef.current.value = ''
      router.push(`/volumes/${data.volumeImportId}`)
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
              Upload purchase history
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleUpload}>
                <DialogHeader>
                  <DialogTitle>Upload purchase volumes</DialogTitle>
                  <DialogDescription>
                    Upload an XLS, XLSX, CSV, or PDF purchasing report for one
                    location. We use AI to extract each item, how much you buy,
                    and the average cost you paid — then you review and match
                    before it weights your comparisons.
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
                      <p className="text-xs text-muted-foreground">
                        {fileName}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Location</Label>
                    <Select
                      value={locationId}
                      onValueChange={(v) => setLocationId(v ?? '')}
                      items={Object.fromEntries(
                        locations.map((l) => [String(l.id), l.name]),
                      )}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Required" />
                      </SelectTrigger>
                      <SelectContent>
                        {locations.map((l) => (
                          <SelectItem key={l.id} value={String(l.id)}>
                            {l.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Every row in this file is recorded against this location.
                      Upload one file per location.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="defaultPeriod">Period</Label>
                    <Input
                      id="defaultPeriod"
                      name="defaultPeriod"
                      placeholder="e.g. TTM, 2025, Jan–Dec 2025"
                      value={defaultPeriod}
                      onChange={(e) => setDefaultPeriod(e.target.value)}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      The time span this data covers. Applied to every row
                      unless a row names its own period. You can edit individual
                      rows when reviewing.
                    </p>
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
                        Extracting��
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

      {volumeImports.length === 0 ? (
        <EmptyState
          icon={Upload}
          title="No purchase data yet"
          description="Upload a purchasing-history report for a location. We'll extract each item, quantity, and average cost with AI so you can review, match, and apply them to your comparisons."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {volumeImports.map((imp) => (
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
                  <TableCell>
                    <LocationCell imp={imp} locations={locations} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {imp.defaultPeriod ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {imp.rowCount}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        imp.status === 'discarded' ? 'secondary' : 'default'
                      }
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
                        href={`/api/volumes/file?pathname=${encodeURIComponent(
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
                          nativeButton={false}
                          render={
                            <Link href={`/volumes/${imp.id}`}>Review</Link>
                          }
                        />
                      )}
                      {canEdit && imp.status === 'committed' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleResync(imp.id)}
                          disabled={syncingId === imp.id}
                          title="Re-push this import's current matches into your comparisons (use after re-matching)"
                        >
                          {syncingId === imp.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <RefreshCw className="size-4" />
                          )}
                          Re-sync
                        </Button>
                      )}
                    </div>
                    {syncMsg?.id === imp.id && (
                      <p className="mt-1 text-right text-xs text-muted-foreground">
                        {syncMsg.text}
                      </p>
                    )}
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
