'use client'

import { useRef, useState, useTransition } from 'react'
import {
  CheckCircle2,
  Copy,
  FileKey2,
  KeyRound,
  PlugZap,
  Trash2,
  XCircle,
} from 'lucide-react'
import {
  type ActionResult,
  type SnowflakeSettings,
  deleteSnowflakeSettings,
  saveSnowflakeSettings,
  testSnowflakeConnection,
} from '@/app/actions/snowflake'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type Fields = {
  account: string
  username: string
  role: string
  warehouse: string
  database: string
  schema: string
}

const FIELD_DEFS: {
  name: keyof Fields
  label: string
  placeholder: string
  hint: string
  required?: boolean
}[] = [
  {
    name: 'account',
    label: 'Account identifier',
    placeholder: 'myorg-myaccount',
    hint: 'Org-account name or the account URL.',
    required: true,
  },
  {
    name: 'username',
    label: 'Service user',
    placeholder: 'ACE_PROCUREMENT_SVC',
    hint: 'The user the public key is assigned to.',
    required: true,
  },
  {
    name: 'role',
    label: 'Role',
    placeholder: 'ACE_PROCUREMENT_READER',
    hint: 'Read-only role. Blank uses the user default.',
  },
  {
    name: 'warehouse',
    label: 'Warehouse',
    placeholder: 'REPORTING_WH',
    hint: 'Compute used for queries.',
  },
  {
    name: 'database',
    label: 'Database',
    placeholder: 'PURCHASING',
    hint: 'Optional default database.',
  },
  {
    name: 'schema',
    label: 'Schema',
    placeholder: 'PUBLIC',
    hint: 'Optional default schema.',
  },
]

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function SnowflakeConnectionForm({
  settings,
}: {
  settings: SnowflakeSettings | null
}) {
  const [fields, setFields] = useState<Fields>({
    account: settings?.account ?? '',
    username: settings?.username ?? '',
    role: settings?.role ?? '',
    warehouse: settings?.warehouse ?? '',
    database: settings?.database ?? '',
    schema: settings?.schema ?? '',
  })
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [result, setResult] = useState<ActionResult | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [copied, setCopied] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  function run(name: string, action: () => Promise<ActionResult>, onOk?: () => void) {
    setPendingAction(name)
    setResult(null)
    startTransition(async () => {
      try {
        const res = await action()
        setResult(res)
        if (res.ok) onOk?.()
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : 'Something went wrong.',
        })
      } finally {
        setPendingAction(null)
      }
    })
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    run(
      'save',
      () => saveSnowflakeSettings({ ...fields, privateKey, passphrase }),
      () => {
        setPrivateKey('')
        setPassphrase('')
        if (fileInput.current) fileInput.current.value = ''
      },
    )
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 20_000) {
      setResult({ ok: false, message: 'That file is too large to be a private key.' })
      return
    }
    setPrivateKey(await file.text())
  }

  async function copyPublicKey() {
    if (!settings) return
    await navigator.clipboard.writeText(settings.publicKeyPem)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const status = !settings
    ? { label: 'Not configured', variant: 'outline' as const }
    : settings.lastTestOk === true
      ? { label: 'Connected', variant: 'default' as const }
      : settings.lastTestOk === false
        ? { label: 'Test failed', variant: 'destructive' as const }
        : { label: 'Untested', variant: 'secondary' as const }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <PlugZap className="size-4" aria-hidden />
            </div>
            <div className="flex flex-col gap-0.5">
              <CardTitle className="flex items-center gap-2 text-base">
                Snowflake
                <Badge variant={status.variant}>{status.label}</Badge>
              </CardTitle>
              <CardDescription>
                Key-pair (JWT) authentication for a read-only service user.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELD_DEFS.map((def) => (
                <div key={def.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={`sf-${def.name}`}>
                    {def.label}
                    {def.required && (
                      <span className="text-destructive" aria-hidden>
                        *
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`sf-${def.name}`}
                    name={def.name}
                    value={fields[def.name]}
                    placeholder={def.placeholder}
                    required={def.required}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={`sf-${def.name}-hint`}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, [def.name]: e.target.value }))
                    }
                    className="font-mono text-sm"
                  />
                  <p id={`sf-${def.name}-hint`} className="text-xs text-muted-foreground">
                    {def.hint}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="sf-private-key" className="flex items-center gap-2">
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                  Private key (PEM)
                  {!settings && (
                    <span className="text-destructive" aria-hidden>
                      *
                    </span>
                  )}
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  <FileKey2 aria-hidden />
                  Load .p8 file
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".p8,.pem,.key,text/plain"
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Private key file"
                  onChange={handleFile}
                />
              </div>
              <Textarea
                id="sf-private-key"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder={
                  settings
                    ? `A key is on file (${settings.publicKeyFingerprint}). Paste a new key only to replace it.`
                    : '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
                }
                rows={6}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sf-passphrase">Key passphrase</Label>
                <Input
                  id="sf-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Only for encrypted keys"
                  autoComplete="new-password"
                  className="sm:max-w-xs"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The key is validated, encrypted with AES-256-GCM, and stored
                server-side. It is never sent back to the browser.
              </p>
            </div>

            {result && (
              <div
                role="status"
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
                  result.ok
                    ? 'border-primary/30 bg-primary/5 text-foreground'
                    : 'border-destructive/30 bg-destructive/5 text-destructive',
                )}
              >
                {result.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span className="break-words">{result.message}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={isPending}>
                {pendingAction === 'save' ? 'Saving…' : 'Save connection'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isPending || !settings}
                onClick={() => run('test', testSnowflakeConnection)}
              >
                {pendingAction === 'test' ? 'Testing…' : 'Test connection'}
              </Button>
              {settings && (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-destructive hover:text-destructive"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm('Remove the Snowflake connection and its stored key?')) {
                      run('delete', deleteSnowflakeSettings, () => {
                        setFields({
                          account: '',
                          username: '',
                          role: '',
                          warehouse: '',
                          database: '',
                          schema: '',
                        })
                      })
                    }
                  }}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        {settings && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Key on file</CardTitle>
              <CardDescription>
                Compare with RSA_PUBLIC_KEY_FP from{' '}
                <code className="font-mono">DESC USER</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <code className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                {settings.publicKeyFingerprint}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={copyPublicKey}>
                <Copy aria-hidden />
                {copied ? 'Copied' : 'Copy public key'}
              </Button>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Saved</dt>
                <dd>{formatDate(settings.updatedAt)}</dd>
                <dt className="text-muted-foreground">Last test</dt>
                <dd>{settings.lastTestedAt ? formatDate(settings.lastTestedAt) : 'Never'}</dd>
              </dl>
              {settings.lastTestMessage && (
                <p
                  className={cn(
                    'break-words text-xs',
                    settings.lastTestOk ? 'text-muted-foreground' : 'text-destructive',
                  )}
                >
                  {settings.lastTestMessage}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">What to request from your DBAs</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs text-muted-foreground">
              <li>
                A service user with{' '}
                <code className="font-mono text-foreground">TYPE = SERVICE</code>{' '}
                and your RSA public key assigned.
              </li>
              <li>
                A dedicated role with only{' '}
                <code className="font-mono text-foreground">USAGE</code> on the
                warehouse, database, and schema, plus{' '}
                <code className="font-mono text-foreground">SELECT</code> on the
                purchasing tables or views.
              </li>
              <li>
                That role set as the user&apos;s default, and the account
                identifier, warehouse, database, and schema names.
              </li>
              <li>
                Optionally, a network policy allowing Vercel&apos;s egress IPs.
              </li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
