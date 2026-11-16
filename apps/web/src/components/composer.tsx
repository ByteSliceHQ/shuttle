import { ArrowUp, Paperclip, SlidersHorizontal, Sparkles, Target, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import type { AgentIdentity } from '@/lib/agents'
import {
  DEFAULT_TEAM,
  fetchSessionTeam,
  fetchSessionVendorModels,
  say,
  setDefaultHarness,
  setLlmModel,
  setSessionDefaults,
  setSessionHarness,
  setSessionTeam,
  setSessionVendorModel,
  type HarnessId,
  type Team,
  type VendorHarnessId,
  type VendorModelChoice,
  type VendorModelChoices,
  peekSessionTeam,
  peekSessionVendorModels,
} from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'
import { readStoredLlmModel, writeStoredLlmModel, type OpenRouterModelId } from '@/lib/llm-models'
import { routeStyles } from '@/lib/routes'
import { interjectionKinds, isInterjectionKind, type InterjectionKind } from '@/lib/session-feed'
import { effectiveTeam } from '@/lib/team'
import { useTenant } from '@/lib/tenant'
import { useRunStore } from '@swirls/looms/react'

import { AttachmentTray, releaseAttachments, useComposerAttachments } from './composer-attachments'
import { ContextUsage } from './context-usage'
import { HarnessSwitcher } from './harness-switcher'
import { ModelSwitcher } from './model-switcher'
import { SignInGate, useAgentGate, useSessionRunsAt } from './sign-in'
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
/** Team members a message can be addressed to, as `@<mention>` for the conductor to route. */
type Mention = 'worker' | 'codex' | 'claude' | 'cursor'

const MENTION_LABELS: Record<Mention, string> = {
  worker: 'Shuttle worker',
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
}

const ADDRESSED = /^@(worker|codex|claude|cursor)\b/i

function teamMentions(team: Team): Mention[] {
  const mentions: Mention[] = []

  if (team.workers) {
    mentions.push('worker')
  }

  if (team.codex) {
    mentions.push('codex')
  }

  if (team.claudeCode) {
    mentions.push('claude')
  }

  if (team.cursor) {
    mentions.push('cursor')
  }

  return mentions
}

/** Whether a drag is of files, and not of text or a tab being reordered. */
function carriesFiles(event: DragEvent) {
  return event.dataTransfer.types.includes('Files')
}

const STARTER_KINDS = ['question', 'idea', 'constraint', 'correction'] as const

export function Composer({
  runId,
  identities,
  harness,
  onHarnessChange: reportHarness,
  disabled = false,
  showExamples = true,
  context,
  targetThreadId,
}: {
  runId: string
  /** Which agent runs this session. Owned by the session page, which also names the agent. */
  harness: HarnessId
  onHarnessChange: (harness: HarnessId) => void
  identities: ReadonlyMap<string, AgentIdentity>
  disabled?: boolean
  showExamples?: boolean
  /**
   * The agent whose timeline is open. Messages go to it while it is, unless the sender picks
   * someone else.
   */
  targetThreadId?: string
  /** What the session works from (repos, brief), shown under the composer on the left. */
  context?: ReactNode
}) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<InterjectionKind | typeof AUTO>(AUTO)
  const [target, setTarget] = useState<string>(targetThreadId ?? AUTO)
  const [followedThreadId, setFollowedThreadId] = useState(targetThreadId)

  // Opening or leaving an agent's timeline re-aims the composer at it.
  if (followedThreadId !== targetThreadId) {
    setFollowedThreadId(targetThreadId)
    setTarget(targetThreadId ?? AUTO)
  }

  const [model, setModel] = useState<OpenRouterModelId>(() => readStoredLlmModel())
  // What the session had when it was last open shows at once; the read below corrects it.
  const [team, setTeam] = useState<Team>(() => peekSessionTeam(runId)?.team ?? DEFAULT_TEAM)

  const [vendorChoices, setVendorChoices] = useState<VendorModelChoices>(
    () => peekSessionVendorModels(runId)?.choices ?? {},
  )

  const [mention, setMention] = useState<Mention | null>(null)
  const [inputFocused, setInputFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const files = useComposerAttachments(runId)
  const store = useRunStore(runId)
  const me = useTenant().user
  /** Counts drag enters and leaves, which fire for every element the pointer crosses. */
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)
  const syncedRunId = useRef<string | null>(null)
  /** Messages go out one at a time, so they arrive in the order they were written. */
  const outbox = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (syncedRunId.current === runId) {
      return
    }

    syncedRunId.current = runId
    const preferred = readStoredLlmModel()

    void setLlmModel(runId, preferred).catch((cause: unknown) => {
      setError(errorMessage(cause))
    })

    void fetchSessionTeam(runId).then(
      (result) => setTeam(result.team),
      () => {},
    )

    void fetchSessionVendorModels(runId).then(
      (result) => setVendorChoices(result.choices),
      () => {},
    )
  }, [runId])

  // Only a Shuttle session has a team to address, and only its members can be.
  // A saved team can name an agent that is not connected. It will not run, so it is not offered.
  const runsAt = useSessionRunsAt(runId)
  // An agent that is not signed in where the session runs would only fail the turn, so the
  // message box offers to sign in there first.
  const gate = useAgentGate(harness, runsAt.place)
  const { connections } = gate
  const activeTeam = connections ? effectiveTeam(team, connections, runsAt.place) : team
  const mentions = harness === 'shuttle' ? teamMentions(activeTeam) : []
  const hybrid = mentions.some((member) => member !== 'worker')
  const activeMention = mention && hybrid && mentions.includes(mention) ? mention : null

  const targets = [...identities.values()].filter((identity) =>
    STEERABLE.has(identity.definitionName),
  )

  const selectedTarget =
    target === AUTO ? undefined : targets.find((identity) => identity.threadId === target)

  const effectiveTarget = selectedTarget?.threadId ?? AUTO
  const revealExamples = showExamples && inputFocused && text.length === 0 && !disabled

  // Agents never block the composer: a message can always be written and sent, even while the
  // one before it is still on its way. The one exception is an agent that is not signed in where
  // the session runs, which could only answer with an error.
  function submit(event?: FormEvent) {
    event?.preventDefault()

    if (disabled || gate.blocked) {
      return
    }

    const typed = text.trim()

    // A message may be files alone.
    if (!typed && files.attachments.length === 0) {
      inputRef.current?.focus()
      return
    }

    if (files.attachments.some((attachment) => attachment.status === 'error')) {
      setError('Remove the file that could not be uploaded, or attach it again.')
      return
    }

    const sending = files.take()
    const message = activeMention && typed ? `@${activeMention} ${typed}` : typed
    // A message addressed to an agent is work for it, so it must not be answered as a question.
    const addressed = activeMention !== null || (hybrid && ADDRESSED.test(typed))
    const forceKind = addressed ? 'task' : kind === AUTO ? undefined : kind
    const targetThread = effectiveTarget === AUTO ? undefined : effectiveTarget
    setError(null)
    setText('')
    inputRef.current?.focus()

    outbox.current = outbox.current
      .then(async () => {
        // Files still on their way finish first, so the message never arrives without them.
        const uploaded = await Promise.all(sending.map((attachment) => attachment.uploaded))

        const messageId = crypto.randomUUID()

        // The message shows in the conversation at once, as the session will record it. If the
        // send fails it is taken back out and handed back to the message box below.
        await store.commit(
          {
            type: 'shuttle.user.said',
            payload: {
              messageId,
              text: message,
              ...(forceKind ? { forceKind } : {}),
              ...(targetThread ? { targetThreadId: targetThread } : {}),
              author: { id: me.id, name: me.name || me.email },
              ...(uploaded.length > 0
                ? { attachments: uploaded.map((asset) => ({ ...asset })) }
                : {}),
            },
          },
          {
            optimistic: true,
            // The key the session's `say` signal records the message under.
            idempotencyKey: `shuttle-say:${messageId}`,
            send: () =>
              say(
                runId,
                messageId,
                message,
                forceKind,
                targetThread,
                uploaded.map((asset) => asset.id),
              ),
          },
        )

        releaseAttachments(sending)
      })
      .catch((cause: unknown) => {
        // Hand the message back unless something new has been written since.
        setText((current) => (current.trim() ? current : typed))
        files.restore(sending)
        setError(errorMessage(cause))
      })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files]

    // A screenshot or copied file is attached. Pasted text is left to the textarea.
    if (pasted.length > 0) {
      event.preventDefault()
      files.add(pasted)
    }
  }

  function onDragEnter(event: DragEvent) {
    if (disabled || !carriesFiles(event)) {
      return
    }

    event.preventDefault()
    dragDepth.current += 1
    setDropping(true)
  }

  function onDragLeave(event: DragEvent) {
    if (!carriesFiles(event)) {
      return
    }

    dragDepth.current = Math.max(0, dragDepth.current - 1)

    if (dragDepth.current === 0) {
      setDropping(false)
    }
  }

  function onDrop(event: DragEvent) {
    if (disabled || !carriesFiles(event)) {
      return
    }

    event.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    files.add([...event.dataTransfer.files])
    inputRef.current?.focus()
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

  function onTeamChange(next: Team) {
    setTeam(next)
    setError(null)

    // Applies from the conductor's next turn, and to sessions started after this.
    void Promise.all([setSessionTeam(runId, next), setSessionDefaults({ team: next })]).then(
      // Show what the session actually stored, so the picker can never disagree with it.
      ([saved]) => setTeam(saved.team),
      (cause: unknown) => {
        setError(errorMessage(cause))

        void fetchSessionTeam(runId).then(
          (result) => setTeam(result.team),
          () => {},
        )
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

  function onVendorChoiceChange(agent: VendorHarnessId, choice: VendorModelChoice) {
    setVendorChoices((current) => ({ ...current, [agent]: choice }))
    setError(null)

    // Applies from that agent's next turn.
    void setSessionVendorModel(runId, agent, choice).then(
      (saved) => setVendorChoices(saved.choices),
      (cause: unknown) => {
        setError(errorMessage(cause))

        void fetchSessionVendorModels(runId).then(
          (result) => setVendorChoices(result.choices),
          () => {},
        )
      },
    )
  }

  return (
    <div className="relative z-10 -mt-5 shrink-0 px-4 pt-5 pb-2.5 sm:px-6">
      <div
        aria-hidden
        className="from-background via-background/85 pointer-events-none absolute inset-x-0 top-0 bottom-0 -z-10 bg-linear-to-t via-65% to-transparent"
      />
      <div className="@container mx-auto w-full max-w-3xl">
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
          onDragEnter={onDragEnter}
          onDragOver={(event) => {
            // Without this the browser opens a dropped file in place of the page.
            if (carriesFiles(event)) {
              event.preventDefault()
            }
          }}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            'bg-card focus-within:border-ring/60 focus-within:ring-ring/20 relative rounded-xl border shadow-lg shadow-black/20 transition-[border-color,box-shadow] duration-150 focus-within:ring-[3px]',
            dropping && 'border-brand/70 ring-brand/25 ring-[3px]',
          )}
        >
          {dropping ? (
            <div className="bg-card/90 text-foreground pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl text-[13px] font-medium">
              <Paperclip className="size-4" />
              Drop files to attach
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={(event) => {
              files.add([...(event.target.files ?? [])])
              // Cleared so choosing the same file again still fires a change.
              event.target.value = ''
              inputRef.current?.focus()
            }}
          />
          {gate.blocked && gate.connection && runsAt.place ? (
            <SignInGate
              connection={gate.connection}
              place={runsAt.place}
              onSignedIn={gate.reload}
              onMoveToCloud={() => {
                setError(null)
                runsAt.moveToCloud().catch((cause: unknown) => setError(errorMessage(cause)))
              }}
            />
          ) : null}
          <AttachmentTray attachments={files.attachments} onRemove={files.remove} />
          <textarea
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach files"
                    className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 ease-snappy inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50"
                  >
                    <Paperclip className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  Attach images, video, audio or files
                </TooltipContent>
              </Tooltip>
              <SteerMenu
                kind={kind}
                onKindChange={setKind}
                target={effectiveTarget}
                onTargetChange={setTarget}
                targets={targets}
                mentions={hybrid ? mentions : []}
                mention={activeMention}
                onMentionChange={setMention}
                disabled={disabled}
              />
              {activeMention ? (
                <OverridePill
                  label={`@${activeMention}`}
                  icon={<Target className="size-3 shrink-0 opacity-75" />}
                  clearLabel={`Stop addressing ${MENTION_LABELS[activeMention]}`}
                  onClear={() => setMention(null)}
                />
              ) : null}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    variant={disabled || gate.blocked ? 'secondary' : 'brand'}
                    size="icon-sm"
                    disabled={disabled || gate.blocked}
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
        {error || files.rejection ? (
          <p role="alert" className="text-status-failed mt-2 text-xs">
            {error ?? files.rejection}
          </p>
        ) : null}
        {/* One line at any width: the model name truncates before anything wraps. */}
        {/* Inset so its first and last icons sit under the steer and send buttons. */}
        <div className="mt-1.5 flex items-center justify-between gap-2 px-1.5">
          <div className="flex shrink-0 items-center gap-0.5">{context}</div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
            <HarnessSwitcher
              value={harness}
              onChange={onHarnessChange}
              team={team}
              onTeamChange={onTeamChange}
              disabled={disabled}
              place={runsAt.place}
            />
            <ModelSwitcher
              harness={harness}
              team={activeTeam}
              value={model}
              onChange={onModelChange}
              vendorChoices={vendorChoices}
              onVendorChoiceChange={onVendorChoiceChange}
              disabled={disabled}
            />
            {harness === 'shuttle' ? <ContextUsage runId={runId} modelId={model} /> : null}
          </div>
        </div>
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
  mentions,
  mention,
  onMentionChange,
  disabled,
}: {
  kind: InterjectionKind | typeof AUTO
  onKindChange: (next: InterjectionKind | typeof AUTO) => void
  target: string
  onTargetChange: (next: string) => void
  targets: readonly AgentIdentity[]
  /** Team members the message can be addressed to. Empty outside a hybrid session. */
  mentions: readonly Mention[]
  mention: Mention | null
  onMentionChange: (next: Mention | null) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasOverride = kind !== AUTO || target !== AUTO || mention !== null

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

        {mentions.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Hand to</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mention ?? AUTO}
              onValueChange={(next) => onMentionChange(next === AUTO ? null : (next as Mention))}
            >
              <DropdownMenuRadioItem value={AUTO} description="The conductor picks who does it">
                <span>Conductor decides</span>
              </DropdownMenuRadioItem>
              {mentions.map((member) => (
                <DropdownMenuRadioItem
                  key={member}
                  value={member}
                  description={`Sent as @${member} for the conductor to pass on`}
                >
                  <span>{MENTION_LABELS[member]}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}

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
