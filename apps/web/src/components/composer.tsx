import { ArrowUp, Sparkles, Target } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type { AgentIdentity } from '@/lib/agents'
import { say, setLlmModel } from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'
import { readStoredLlmModel, writeStoredLlmModel, type OpenRouterModelId } from '@/lib/llm-models'
import { routeStyles } from '@/lib/routes'
import { interjectionKinds, isInterjectionKind, type InterjectionKind } from '@/lib/session-feed'

import { ModelSwitcher } from './model-switcher'
import { Button } from './ui/button'
import { Kbd } from './ui/panel'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

const AUTO = 'auto'
const STEERABLE = new Set(['conductor', 'worker'])

export function Composer({
  runId,
  identities,
  disabled = false,
  showExamples = true,
}: {
  runId: string
  identities: ReadonlyMap<string, AgentIdentity>
  disabled?: boolean
  showExamples?: boolean
}) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<InterjectionKind | typeof AUTO>(AUTO)
  const [target, setTarget] = useState<string>(AUTO)
  const [model, setModel] = useState<OpenRouterModelId>(() => readStoredLlmModel())
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const syncedRunId = useRef<string | null>(null)

  useEffect(() => {
    if (syncedRunId.current === runId) {
      return
    }

    syncedRunId.current = runId
    const preferred = readStoredLlmModel()

    void setLlmModel(runId, preferred).catch((cause: unknown) => {
      setError(errorMessage(cause))
    })
  }, [runId])

  const targets = [...identities.values()].filter((identity) =>
    STEERABLE.has(identity.definitionName),
  )

  const canSend = text.trim().length > 0 && !sending && !disabled

  function submit(event?: FormEvent) {
    event?.preventDefault()

    if (!canSend) {
      return
    }

    const message = text.trim()
    setSending(true)
    setError(null)
    // Clear optimistically so rapid interjections feel instant; restore on failure.
    setText('')

    void say(runId, message, kind === AUTO ? undefined : kind, target === AUTO ? undefined : target)
      .catch((cause: unknown) => {
        setText(message)
        setError(errorMessage(cause))
      })
      .finally(() => {
        setSending(false)
        inputRef.current?.focus()
      })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  function onModelChange(next: OpenRouterModelId) {
    setModel(next)
    writeStoredLlmModel(next)
    setError(null)

    void setLlmModel(runId, next).catch((cause: unknown) => {
      setError(errorMessage(cause))
    })
  }

  return (
    <div className="shrink-0 px-4 pb-4 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {showExamples && text.length === 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(['question', 'idea', 'constraint', 'correction'] as const).map((example) => {
              const style = routeStyles[example]
              const Icon = style.icon
              return (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setText(style.example)
                    setKind(AUTO)
                    inputRef.current?.focus()
                  }}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent/60 bg-card/50 inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-[background-color,color,scale] duration-150 active:scale-[0.97]"
                >
                  <Icon className={cn('size-3', style.tone)} />
                  {style.example}
                </button>
              )
            })}
          </div>
        ) : null}
        <form
          onSubmit={submit}
          className="bg-card focus-within:border-ring/60 focus-within:ring-ring/20 rounded-xl border shadow-lg shadow-black/20 transition-[border-color,box-shadow] duration-150 focus-within:ring-[3px]"
        >
          <textarea
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={disabled}
            placeholder="Interject anytime: ask, suggest, constrain, correct…"
            aria-label="Message the session"
            className="placeholder:text-muted-foreground/70 block field-sizing-content max-h-48 min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
            <Select
              value={kind}
              onValueChange={(value) => setKind(isInterjectionKind(value) ? value : AUTO)}
            >
              <SelectTrigger aria-label="Route as">
                {kind === AUTO ? (
                  <Sparkles className="size-3" />
                ) : (
                  <span className={cn('size-1.5 rounded-full', routeStyles[kind].dot)} />
                )}
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" side="top">
                <SelectItem value={AUTO} description="Intake classifies the message">
                  Auto route
                </SelectItem>
                {interjectionKinds.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    description={routeStyles[option].description}
                  >
                    {routeStyles[option].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targets.length > 0 ? (
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label="Target agent">
                  <Target className="size-3" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" side="top">
                  <SelectItem value={AUTO} description="Session picks the recipient">
                    Any agent
                  </SelectItem>
                  {targets.map((identity) => (
                    <SelectItem
                      key={identity.threadId}
                      value={identity.threadId}
                      description={identity.role.blurb}
                    >
                      {identity.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <ModelSwitcher value={model} onChange={onModelChange} disabled={disabled} />
            <span className="text-muted-foreground ml-auto hidden items-center gap-1 pr-1 text-[11px] sm:inline-flex">
              <Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> newline
            </span>
            <Button
              type="submit"
              variant="brand"
              size="icon"
              disabled={!canSend}
              aria-label="Send"
              className="rounded-lg"
            >
              <ArrowUp />
            </Button>
          </div>
        </form>
        {error ? <p className="text-status-failed mt-2 text-xs">{error}</p> : null}
      </div>
    </div>
  )
}
