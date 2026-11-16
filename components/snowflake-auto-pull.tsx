'use client'

import { useState, useTransition } from 'react'
import { CalendarClock } from 'lucide-react'
import {
  type AutoPullSettings,
  saveAutoPullSchedule,
} from '@/app/actions/snowflake-schedule'
import {
  type AutoPullFrequency,
  CRON_HOUR_UTC,
  WEEKDAYS,
  describeSchedule,
} from '@/lib/auto-pull-schedule'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const FREQUENCY_LABELS: Record<AutoPullFrequency, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

function runTimeLabel() {
  const d = new Date()
  d.setUTCHours(CRON_HOUR_UTC, 0, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

export function SnowflakeAutoPull({
  settings,
  ready,
}: {
  settings: AutoPullSettings | null
  ready: boolean
}) {
  const [frequency, setFrequency] = useState<AutoPullFrequency>(settings?.frequency ?? 'off')
  const [weekday, setWeekday] = useState(settings?.weekday ?? 1)
  const [monthDay, setMonthDay] = useState(settings?.monthDay ?? 1)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const save = () =>
    startTransition(async () => {
      const res = await saveAutoPullSchedule({ frequency, weekday, monthDay })
      setNotice(
        res.ok
          ? { ok: true, text: `Saved. ${describeSchedule({ frequency, weekday, monthDay })}` }
          : { ok: false, text: res.message },
      )
    })

  const failed = settings?.lastOk === false

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-5" aria-hidden="true" />
          Automatic pull
        </CardTitle>
        <CardDescription>
          Runs the same pull as the button above on a schedule, using the saved mapping, filters,
          and site rollup. Results are staged as volume imports for review; nothing is applied
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="auto-pull-frequency">Frequency</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency(v as AutoPullFrequency)}
              disabled={!ready}
            >
              <SelectTrigger id="auto-pull-frequency" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FREQUENCY_LABELS) as AutoPullFrequency[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {FREQUENCY_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {frequency === 'weekly' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-pull-weekday">Day of week</Label>
              <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                <SelectTrigger id="auto-pull-weekday" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((name, i) => (
                    <SelectItem key={name} value={String(i)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {frequency === 'monthly' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-pull-monthday">Day of month</Label>
              <Select value={String(monthDay)} onValueChange={(v) => setMonthDay(Number(v))}>
                <SelectTrigger id="auto-pull-monthday" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_DAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button onClick={save} disabled={!ready || pending}>
            Save schedule
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          {frequency === 'off'
            ? 'Automatic pulls are off.'
            : `Runs around ${runTimeLabel()} on scheduled days. A missed or failed run is retried the next day.`}
          {!ready && ' Connect Snowflake and map at least one site first.'}
        </p>

        {settings?.lastAttemptAt && (
          <div className="flex flex-col gap-1 rounded-md border p-4 text-sm">
            <p className={cn('font-medium', failed && 'text-destructive')}>
              Last automatic run {failed ? 'failed' : 'succeeded'} on{' '}
              {new Date(settings.lastAttemptAt).toLocaleString()}
            </p>
            {settings.lastMessage && (
              <p className="text-muted-foreground">{settings.lastMessage}</p>
            )}
            {failed && settings.lastSuccessAt && (
              <p className="text-muted-foreground">
                Last success: {new Date(settings.lastSuccessAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        <div aria-live="polite">
          {notice && (
            <p className={cn('text-sm', notice.ok ? 'text-muted-foreground' : 'text-destructive')}>
              {notice.text}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
