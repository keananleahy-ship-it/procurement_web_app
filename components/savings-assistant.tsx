'use client'

import { useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Loader2, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const EXAMPLE_PROMPTS = [
  'How much could be saved by converting hydraulic oil purchases at all locations to ALS?',
  'What are my five biggest savings opportunities?',
  'Which location has the most unrealized savings, and why?',
  'Compare gear oil pricing across vendors.',
]

// Pull the rendered text out of a UIMessage's parts.
function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

// True while the message is still running a data-lookup tool call.
function isUsingTool(message: UIMessage): boolean {
  return (message.parts ?? []).some(
    (p) =>
      (p.type.startsWith('tool-') || p.type === 'dynamic-tool') &&
      'state' in p &&
      p.state !== 'output-available' &&
      p.state !== 'output-error',
  )
}

export function SavingsAssistant() {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/savings-assistant' }),
    onFinish: () => {
      // keep the latest answer in view
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: 'smooth',
        })
      })
    },
  })

  const busy = status === 'submitted' || status === 'streaming'

  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    sendMessage({ text: trimmed })
    setInput('')
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    })
  }

  const hasConversation = messages.length > 0

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            Savings Assistant
          </h2>
          <p className="text-xs text-muted-foreground">
            Ask anything about savings, vendors, and volumes
          </p>
        </div>
      </div>

      {/* Conversation */}
      {hasConversation && (
        <div
          ref={scrollRef}
          className="flex max-h-[28rem] flex-col gap-4 overflow-y-auto px-5 py-4"
        >
          {messages.map((m) => {
            const text = messageText(m)
            const usingTool = isUsingTool(m)
            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                    {text}
                  </div>
                </div>
              )
            }
            return (
              <div key={m.id} className="flex flex-col gap-2">
                {usingTool && !text && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Analyzing savings data…
                  </div>
                )}
                {text && (
                  <div className="prose-assistant max-w-none text-sm leading-relaxed text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {text}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )
          })}
          {status === 'submitted' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Thinking…
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              Something went wrong. Please try again.
            </p>
          )}
        </div>
      )}

      {/* Empty state: example prompts */}
      {!hasConversation && (
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="text-xs font-medium text-muted-foreground">
            Try asking
          </p>
          <div className="flex flex-col gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => submit(p)}
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-border p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
          className="flex items-end gap-2"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(input)
              }
            }}
            placeholder="e.g. How much could switching grease to one vendor save?"
            rows={1}
            className="max-h-32 min-h-10 flex-1 resize-none"
            disabled={busy}
          />
          <Button
            type="submit"
            size="icon"
            disabled={busy || !input.trim()}
            className={cn('size-10 shrink-0')}
            aria-label="Send message"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </form>
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          Answers are generated from your live pricing and volume data and may
          contain mistakes — verify before acting.
        </p>
      </div>
    </Card>
  )
}
