'use client'

import { useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import { Button } from '@/components/ui/button'
import { Archive, Check } from 'lucide-react'

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; percent: number }
  | { kind: 'done'; fileName: string }
  | { kind: 'error'; message: string }

export function RawVolumeUpload() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function handleFile(file: File) {
    setState({ kind: 'uploading', fileName: file.name, percent: 0 })
    try {
      const safeName = file.name.replace(/[^\w.\-]+/g, '_')
      await upload(`raw-volumes/${safeName}`, file, {
        access: 'private',
        handleUploadUrl: '/api/volumes/raw',
        multipart: file.size > 50 * 1024 * 1024,
        onUploadProgress: ({ percentage }) =>
          setState({
            kind: 'uploading',
            fileName: file.name,
            percent: Math.round(percentage),
          }),
      })
      setState({ kind: 'done', fileName: file.name })
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Upload failed.',
      })
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-3">
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {state.kind === 'uploading' &&
          `Uploading ${state.fileName}… ${state.percent}%`}
        {state.kind === 'done' && (
          <span className="inline-flex items-center gap-1 text-foreground">
            <Check className="size-4 text-primary" />
            {`${state.fileName} stored. Nothing was parsed or committed.`}
          </span>
        )}
        {state.kind === 'error' && (
          <span className="text-destructive">{state.message}</span>
        )}
      </p>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept=".xls,.xlsx,.csv,.zip"
        aria-label="Raw purchase history file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={state.kind === 'uploading'}
        onClick={() => inputRef.current?.click()}
        title="Store a large consolidated file for review. It is not parsed or applied."
      >
        <Archive className="size-4" />
        Upload raw file
      </Button>
    </div>
  )
}
