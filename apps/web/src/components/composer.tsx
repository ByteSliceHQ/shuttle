import { ArrowUp, SlidersHorizontal, Sparkles, Target, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import type { AgentIdentity } from '@/lib/agents'
import { say, setDefaultHarness, setLlmModel, setSessionHarness, type HarnessId } from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'
import { readStoredLlmModel, writeStoredLlmModel, type OpenRouterModelId } from '@/lib/llm-models'
import { routeStyles } from '@/lib/routes'
import { interjectionKinds, isInterjectionKind, type InterjectionKind } from '@/lib/session-feed'

import { ContextUsage } from './context-usage'
import { HarnessSwitcher } from './harness-switcher'
import { ModelSwitcher } from './model-switcher'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Kbd } from './ui/panel'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const AUTO = 'auto'
const STEERABLE = new Set(['conductor', 'worker'])
const STARTER_KINDS = ['question', 'idea', 'constraint', 'correction'] as const

export function Composer({
  runId,
  identities,
  harness,
  onHarnessChange: reportHarness,
  disabled = false,
  showExamples = true,
}: {
  runId: string
  /** Which agent runs this session. Owned by the session page, which also names the agent. */
  harness: HarnessId
  onHarnessChange: (harness: HarnessId) => void
  identities: ReadonlyMap<string, AgentIdentity>
  disabled?: boolean
  showExamples?: boolean
}) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<InterjectionKind | typeof AUTO>(AUTO)
  const [target, setTarget] = useState<string>(AUTO)
  const [model, setModel] = useState<OpenRouterModelId>(() => readStoredLlmModel())
  const [sending, setSending] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
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

  const selectedTarget =
    target === AUTO ? undefined : targets.find((identity) => identity.threadId === target)

  const effectiveTarget = selectedTarget?.threadId ?? AUTO
  const canSend = text.trim().length > 0 && !sending && !disabled
  const revealExamples = showExamples && inputFocused && text.length === 0 && !disabled

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

    void say(
      runId,
      message,
      kind === AUTO ? undefined : kind,
      effectiveTarget === AUTO ? undefined : effectiveTarget,
    )
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

  function onHarnessChange(next: HarnessId) {
    reportHarness(next)
    setError(null)

    // Applies from this session's next turn, and to sessions started after this.
    void Promise.all([setSessionHarness(runId, next), setDefaultHarness(next)]).catch(
      (cause: unknown) => {
        setError(errorMessage(cause))
      },
    )
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
    <div className="relative z-10 -mt-5 shrink-0 px-4 pt-5 pb-4 sm:px-6">
      <div
        aria-hidden
        className="from-background via-background/85 pointer-events-none absolute inset-x-0 top-0 bottom-0 -z-10 bg-linear-to-t via-65% to-transparent"
      />
      <div className="mx-auto w-full max-w-3xl">
        {showExamples ? (
          <StarterSuggestions
            visible={revealExamples}
            onPick={(example) => {
              setText(example)
              setKind(AUTO)
              inputRef.current?.focus()
            }}
          />
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
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            rows={1}
            disabled={disabled}
            placeholder="Ask anything. Questions don't interrupt the agents."
            aria-label="Message the session"
            className="placeholder:text-muted-foreground/70 block field-sizing-content max-h-48 min-h-11 w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1.5 text-[13.5px] leading-relaxed outline-none disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-1.5 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <SteerMenu
                kind={kind}
                onKindChange={setKind}
                target={effectiveTarget}
                onTargetChange={setTarget}
                targets={targets}
                disabled={disabled}
              />
              {kind !== AUTO ? (
                <OverridePill
                  label={routeStyles[kind].label}
                  icon={
                    <span className={cn('size-1.5 shrink-0 rounded-full', routeStyles[kind].dot)} />
                  }
                  clearLabel={`Reset route from ${routeStyles[kind].label}`}
                  onClear={() => setKind(AUTO)}
                />
              ) : null}
              {selectedTarget ? (
                <OverridePill
                  label={selectedTarget.label}
                  icon={<Target className="size-3 shrink-0 opacity-75" />}
                  clearLabel={`Reset target from ${selectedTarget.label}`}
                  onClear={() => setTarget(AUTO)}
                />
              ) : null}
            </div>

            <div className="flex min-w-0 items-center gap-1">
              <HarnessSwitcher value={harness} onChange={onHarnessChange} disabled={disabled} />
              {harness === 'shuttle' ? (
                <>
                  <ModelSwitcher value={model} onChange={onModelChange} disabled={disabled} />
                  <ContextUsage runId={runId} modelId={model} />
                </>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    variant={canSend ? 'brand' : 'secondary'}
                    size="icon-sm"
                    disabled={!canSend}
                    aria-label="Send message"
                    className="rounded-lg"
                  >
                    <ArrowUp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  <span className="inline-flex items-center gap-1">
                    Send <Kbd>↵</Kbd>
                  </span>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </form>
        {error ? <p className="text-status-failed mt-2 text-xs">{error}</p> : null}
      </div>
    </div>
  )
}

function StarterSuggestions({
  visible,
  onPick,
}: {
  visible: boolean
  onPick: (example: string) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [fadeLeft, setFadeLeft] = useState(false)
  const [fadeRight, setFadeRight] = useState(true)

  const syncEdges = useCallback(() => {
    const el = scrollerRef.current

    if (!el) {
      return
    }

    setFadeLeft(el.scrollLeft > 2)
    setFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])

  useEffect(() => {
    const el = scrollerRef.current

    if (!el) {
      return
    }

    syncEdges()
    const observer = new ResizeObserver(syncEdges)
    observer.observe(el)

    return () => observer.disconnect()
  }, [syncEdges])

  const maskImage =
    fadeLeft && fadeRight
      ? 'linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)'
      : fadeLeft
        ? 'linear-gradient(to right, transparent, black 28px)'
        : fadeRight
          ? 'linear-gradient(to right, black calc(100% - 28px), transparent)'
          : undefined

  return (
    <div
      inert={!visible}
      className={cn(
        'ease-snappy grid transition-[grid-template-rows,opacity,margin-bottom] duration-180 motion-reduce:transition-none',
        visible ? 'mb-2 grid-rows-[1fr] opacity-100' : 'mb-0 grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          ref={scrollerRef}
          onScroll={syncEdges}
          style={maskImage ? { maskImage } : undefined}
          className="flex [scrollbar-width:none] items-center gap-1.5 overflow-x-auto pb-0.5 [&::-webkit-scrollbar]:hidden"
        >
          {STARTER_KINDS.map((example) => {
            const style = routeStyles[example]
            const Icon = style.icon

            return (
              <button
                key={example}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(style.example)}
                className="text-muted-foreground hover:text-foreground hover:bg-accent/60 bg-card/60 ease-snappy inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.97]"
              >
                <Icon className={cn('size-3 shrink-0', style.tone)} />
                {style.example}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SteerMenu({
  kind,
  onKindChange,
  target,
  onTargetChange,
  targets,
  disabled,
}: {
  kind: InterjectionKind | typeof AUTO
  onKindChange: (next: InterjectionKind | typeof AUTO) => void
  target: string
  onTargetChange: (next: string) => void
  targets: readonly AgentIdentity[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasOverride = kind !== AUTO || target !== AUTO

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            aria-label="Steer routing and target"
            className={cn(
              'hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50',
              hasOverride ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <SlidersHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
          Steer routing & target
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-60"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>Route as</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={kind}
          onValueChange={(value) => onKindChange(isInterjectionKind(value) ? value : AUTO)}
        >
          <DropdownMenuRadioItem value={AUTO} description="Intake classifies the message">
            <Sparkles className="text-muted-foreground size-3 shrink-0" />
            <span>Auto route</span>
          </DropdownMenuRadioItem>
          {interjectionKinds.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              description={routeStyles[option].description}
            >
              <span className={cn('size-1.5 shrink-0 rounded-full', routeStyles[option].dot)} />
              <span>{routeStyles[option].label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {targets.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Target agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={target} onValueChange={onTargetChange}>
              <DropdownMenuRadioItem value={AUTO} description="Session picks the recipient">
                <Target className="text-muted-foreground size-3 shrink-0" />
                <span>Any agent</span>
              </DropdownMenuRadioItem>
              {targets.map((identity) => (
                <DropdownMenuRadioItem
                  key={identity.threadId}
                  value={identity.threadId}
                  description={identity.role.blurb}
                >
                  <span>{identity.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OverridePill({
  label,
  icon,
  clearLabel,
  onClear,
}: {
  label: string
  icon: ReactNode
  clearLabel: string
  onClear: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={clearLabel}
      className="bg-secondary/80 text-foreground hover:bg-accent ease-snappy inline-flex h-6 max-w-32 min-w-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97]"
    >
      {icon}
      <span className="truncate">{label}</span>
      <X className="text-muted-foreground size-3 shrink-0" />
    </button>
  )
}
