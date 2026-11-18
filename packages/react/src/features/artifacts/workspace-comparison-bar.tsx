import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Moon,
  Package,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { parseComparison, type SandboxWorkspace } from '@shuttle/api'

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { ScrollArea } from '../../components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { fullDateTime, relativeTime } from '../../lib/time'
import { useNow } from '../../lib/use-now'
import { useApi, useOrgPeople, useTenant } from '../../shuttle'
import type { WorkspaceRepo } from './sandbox'
import {
  comparisonTitle,
  pullComparison,
  pullShown,
  pullSync,
  railBrackets,
  railPoints,
  railSpan,
  repoOfPull,
  SESSION,
  shortRef,
  shortSha,
  type RailPoint,
  type RunPull,
} from './workspace-comparison'

/** A repository as people know it: its GitHub name, or "Scratch" for a folder with none linked. */
export function repoLabel(repo: WorkspaceRepo): string {
  return repo.fullName ?? 'Scratch'
}

/** What pressing a button feels like: it gives a little, at once. */
const PRESS =
  'transition-[color,background-color,border-color,scale] duration-150 ease-snappy active:scale-[0.97]'

/**
 * A branch name, shortened in the middle when it is a long one. The whole name is there on hover.
 * It gives way to an ellipsis where even the short form does not fit.
 */
function RefName({ name, className }: { name: string; className?: string }) {
  const short = shortRef(name)

  return (
    <span
      title={short === name ? undefined : name}
      className={cn('inline-block max-w-full min-w-0 truncate align-bottom', className)}
    >
      {short}
    </span>
  )
}

type Tone = 'muted' | 'good' | 'wait' | 'bad'

interface Fact {
  readonly label: string
  readonly tone?: Tone
  readonly title?: string
}

/** What GitHub and the sandbox say about a pull request, most telling last. */
function pullFacts(run: RunPull, repo: WorkspaceRepo | undefined): Fact[] {
  const { pull } = run
  const sync = pullSync(pull, repo)
  const open = pull.state === 'open'

  const facts: (Fact | null)[] = [
    pull.state === 'closed'
      ? { label: 'Closed' }
      : pull.draft
        ? { label: 'Draft' }
        : { label: 'Open', tone: 'good' },
    run.role === 'reviewer' ? { label: 'Reviewing' } : null,
    open && pull.checkRollup === 'passing'
      ? { label: 'Checks pass', tone: 'good' }
      : open && pull.checkRollup === 'failing'
        ? { label: 'Checks fail', tone: 'bad' }
        : open && pull.checkRollup === 'pending'
          ? { label: 'Checks running', tone: 'wait' }
          : null,
    pull.reviewDecision === 'approved'
      ? { label: 'Approved', tone: 'good' }
      : pull.reviewDecision === 'changes_requested'
        ? { label: 'Changes requested', tone: 'bad' }
        : null,
    sync === 'unpushed'
      ? {
          label: 'Not pushed',
          tone: 'wait',
          title: 'The sandbox has commits on this branch that GitHub does not.',
        }
      : sync === 'uncommitted'
        ? {
            label: 'Uncommitted work',
            tone: 'wait',
            title: 'This branch is checked out with work not committed yet.',
          }
        : sync === 'pushed'
          ? {
              label: 'Up to date',
              title: 'GitHub has everything the sandbox has on this branch.',
            }
          : null,
  ]

  return facts.filter((fact) => fact !== null)
}

/**
 * A pull request's facts as one quiet line of words. Only the ones that say something is good,
 * waiting or wrong take a colour, so they are what the eye lands on.
 */
function PullFacts({ facts }: { facts: readonly Fact[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-1.5 text-[11px]">
      {facts.map((fact, index) => (
        <span key={fact.label} title={fact.title} className="whitespace-nowrap">
          <span
            className={cn(
              fact.tone === 'good' && 'text-status-completed',
              fact.tone === 'wait' && 'text-status-waiting',
              fact.tone === 'bad' && 'text-destructive',
            )}
          >
            {fact.label}
          </span>
          {index < facts.length - 1 ? <span aria-hidden> ·</span> : null}
        </span>
      ))}
    </span>
  )
}

/**
 * The session's pull requests, each one a button that shows what it changes. It is the first
 * thing in the tab, so a session that has opened pull requests says so before anything else.
 */
export function RunPullsRow({
  pulls,
  repos,
  shown,
  onShow,
}: {
  pulls: readonly RunPull[]
  repos: readonly WorkspaceRepo[]
  /** The pull request the active repository is showing, if any. */
  shown: number | null
  onShow: (run: RunPull, repo: WorkspaceRepo) => void
}) {
  if (pulls.length === 0) {
    return null
  }

  return (
    <ScrollArea
      horizontal
      vertical={false}
      barClassName="h-1.5"
      className="shrink-0 border-b"
      viewportClassName="[&>div]:flex! [&>div]:w-max [&>div]:gap-1.5 [&>div]:px-2.5 [&>div]:py-2"
    >
      {pulls.map((run) => {
        const { pull } = run
        const repo = repoOfPull(repos, pull)
        const on = shown === pull.number && repo !== undefined
        const stack = pull.stack

        return (
          <button
            key={`${pull.fullName}#${pull.number}`}
            type="button"
            aria-pressed={on}
            disabled={!repo}
            onClick={() => repo && onShow(run, repo)}
            title={
              repo
                ? `Show what ${pull.fullName}#${pull.number} changes`
                : `${pull.fullName} is not in this workspace`
            }
            className={cn(
              'focus-visible:ring-ring/50 text-muted-foreground grid w-[272px] shrink-0 gap-0.5 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 disabled:cursor-default',
              PRESS,
              on
                ? 'border-route-constraint/60 bg-route-constraint/8'
                : 'hover:bg-accent/40 bg-accent/25 border-transparent',
              pull.state === 'closed' && 'opacity-70',
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <GitPullRequest aria-hidden className="text-route-constraint size-3 shrink-0" />
              <span className="text-route-constraint shrink-0 font-mono text-[11px] font-medium">
                #{pull.number}
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate text-[12.5px] font-medium">
                {pull.title}
              </span>
              {stack && stack.size > 1 ? (
                <span
                  className="shrink-0 text-[11px] tabular-nums"
                  title={`Layer ${stack.position} of a stack of ${stack.size}`}
                >
                  {stack.position}/{stack.size}
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 items-baseline gap-2">
              <PullFacts
                facts={[
                  // Which repository only needs saying when there is more than one.
                  ...(repos.length > 1 ? [{ label: pull.fullName.split('/').pop() ?? '' }] : []),
                  ...pullFacts(run, repo),
                ]}
              />
              <span className="ml-auto shrink-0 text-[11px] tabular-nums">
                <span className="text-status-completed">+{pull.additions}</span>{' '}
                <span className="text-destructive">−{pull.deletions}</span>
              </span>
            </span>
          </button>
        )
      })}
    </ScrollArea>
  )
}

/** Whether the files are read live from the sandbox, from a saved copy, or not at all. */
function SourceState({ workspace }: { workspace: SandboxWorkspace }) {
  const now = useNow()
  const me = useTenant().user.id
  const people = useOrgPeople()
  const holder = workspace.holderId && workspace.holderId !== me ? workspace.holderId : null

  const state =
    workspace.source === 'saved'
      ? workspace.savedAt
        ? `Saved ${relativeTime(workspace.savedAt, now)}`
        : 'Saved copy'
      : workspace.source === 'asleep'
        ? 'Asleep'
        : holder
          ? `Live · ${people.get(holder) ?? 'a teammate'}`
          : 'Live'

  const explained =
    workspace.source === 'saved'
      ? `The sandbox is asleep. This is the work as it was last saved${workspace.savedAt ? `, ${fullDateTime(workspace.savedAt)}` : ''}.`
      : workspace.source === 'asleep'
        ? 'The sandbox is asleep and nothing has been saved yet.'
        : holder
          ? `Read live from ${people.get(holder) ?? 'a teammate'}'s sandbox, where the session is working.`
          : 'Read live from the sandbox the session is working in.'

  return (
    <span
      className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[11px]"
      title={explained}
    >
      {workspace.source === 'sandbox' ? (
        <span aria-hidden className="bg-status-completed size-1.5 rounded-full" />
      ) : (
        <Moon aria-hidden className="size-3" />
      )}
      <span className="text-foreground font-medium">{state}</span>
    </span>
  )
}

/**
 * What a comparison goes by, with any branch in it shortened to fit. The words are the ones
 * `comparisonTitle` gives.
 */
function ComparisonName({
  against,
  repo,
  pulls,
}: {
  against: string
  repo: WorkspaceRepo
  pulls: readonly RunPull[]
}) {
  const parsed = parseComparison(against)
  const title = comparisonTitle(against, repo, pulls)

  if (pullShown(against, pulls, repo)) {
    return <span className="shrink-0">{title}</span>
  }

  if (parsed?.kind === 'range') {
    return (
      <>
        <RefName name={parsed.head} className="font-mono" />
        <span className="text-muted-foreground shrink-0 font-normal">from</span>
        <RefName name={parsed.base} className="max-w-[40%] shrink-0 font-mono" />
      </>
    )
  }

  if (parsed?.kind === 'ref' && !title.startsWith('Since')) {
    return (
      <>
        <span className="shrink-0">Compared with</span>
        <RefName name={parsed.ref} className="font-mono" />
      </>
    )
  }

  return <span className="truncate">{title}</span>
}

/**
 * The repositories in the workspace, one tab each with how many files changed and, when it is not
 * the whole session, what they are compared with. With one repository it is just its name.
 */
export function RepoTabs({
  workspace,
  repos,
  active,
  onActive,
  pulls,
}: {
  workspace: SandboxWorkspace
  repos: readonly WorkspaceRepo[]
  active: WorkspaceRepo
  onActive: (name: string) => void
  pulls: readonly RunPull[]
}) {
  return (
    <div className="flex h-8 shrink-0 items-stretch border-b pr-2.5" role="tablist">
      <ScrollArea
        horizontal
        vertical={false}
        barClassName="h-1"
        className="min-w-0 flex-1"
        viewportClassName="[&>div]:flex! [&>div]:h-8 [&>div]:w-max [&>div]:items-stretch [&>div]:px-1"
      >
        {repos.map((repo) => {
          const on = repo.name === active.name
          const against = repo.comparison?.against ?? SESSION
          const Icon = repo.fullName ? GitBranch : Package

          return (
            <button
              key={repo.name}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onActive(repo.name)}
              className={cn(
                'focus-visible:ring-ring/50 flex items-center gap-1.5 border-b-2 px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset',
                on
                  ? 'border-foreground text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              <Icon aria-hidden className="size-3 shrink-0" />
              <span className="max-w-48 truncate">{repoLabel(repo)}</span>
              <span
                className="text-muted-foreground tabular-nums"
                title={`${repo.changes.length} ${repo.changes.length === 1 ? 'file' : 'files'} listed`}
              >
                {repo.changes.length}
              </span>
              {/* The repository in front says what it is compared with just below. */}
              {against !== SESSION && !on ? (
                <span className="bg-ring/15 text-ring flex max-w-64 min-w-0 gap-1 rounded-full px-1.5 text-[10.5px]">
                  <ComparisonName against={against} repo={repo} pulls={pulls} />
                </span>
              ) : null}
            </button>
          )
        })}
      </ScrollArea>
      <SourceState workspace={workspace} />
    </div>
  )
}

/** One choice in the comparison picker. */
function Choice({
  icon,
  title,
  detail,
  aside,
  selected,
  disabled,
  onSelect,
}: {
  icon: ReactNode
  title: ReactNode
  detail?: ReactNode
  aside?: ReactNode
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className="hover:bg-accent focus-visible:bg-accent grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left outline-none disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="text-muted-foreground flex [&_svg]:size-3.5">
        {selected ? <Check className="text-ring" /> : icon}
      </span>
      <span className="truncate text-[12.5px]">{title}</span>
      <span className="text-muted-foreground text-[11px] tabular-nums">{aside}</span>
      {detail ? (
        <span className="text-muted-foreground col-start-2 col-end-4 truncate text-[11px]">
          {detail}
        </span>
      ) : null}
    </button>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-wide uppercase">
      {children}
    </p>
  )
}

/** The branches to compare with, read from the sandbox when the picker opens. */
function BranchChoices({
  runId,
  repo,
  against,
  onPick,
}: {
  runId: string
  repo: WorkspaceRepo
  against: string
  onPick: (against: string) => void
}) {
  const api = useApi()
  const [query, setQuery] = useState('')

  const { data, isPending, error } = useQuery(
    api.sandbox.branches.queryOptions({ input: { id: runId, repo: repo.name }, staleTime: 30_000 }),
  )

  const typed = query.trim()

  const branches = (data?.branches ?? []).filter((branch) =>
    branch.name.toLowerCase().includes(typed.toLowerCase()),
  )

  // A branch name typed in full can be compared with even when the list does not have it.
  const offerTyped =
    typed !== '' &&
    !branches.some((branch) => branch.name === typed) &&
    parseComparison(`ref:${typed}`) !== null

  return (
    <div>
      <input
        id="workspace-compare-branch"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Find a branch in ${repoLabel(repo)}…`}
        autoComplete="off"
        spellCheck={false}
        className="bg-background focus-visible:ring-ring/50 mx-1 mt-0.5 mb-1 h-7 w-[calc(100%-8px)] rounded-md border px-2 text-[12px] outline-none focus-visible:ring-2"
      />
      <div className="max-h-48 overflow-y-auto">
        {isPending ? (
          <p className="text-muted-foreground px-2 py-1.5 text-[11.5px]">Reading branches…</p>
        ) : error ? (
          <p className="text-destructive px-2 py-1.5 text-[11.5px]">{error.message}</p>
        ) : null}
        {branches.map((branch) => (
          <Choice
            key={branch.name}
            icon={<GitBranch />}
            title={<RefName name={branch.name} className="font-mono text-[12px]" />}
            aside={
              branch.name === repo.defaultBranch ? 'default' : branch.remote ? null : 'sandbox only'
            }
            selected={against === `ref:${branch.name}`}
            onSelect={() => onPick(`ref:${branch.name}`)}
          />
        ))}
        {offerTyped ? (
          <Choice
            icon={<GitBranch />}
            title={`Compare with ${typed}`}
            detail="Fetched from GitHub if the sandbox does not have it"
            selected={false}
            onSelect={() => onPick(`ref:${typed}`)}
          />
        ) : !isPending && branches.length === 0 && !error ? (
          <p className="text-muted-foreground px-2 py-1.5 text-[11.5px]">No branch matches.</p>
        ) : null}
      </div>
    </div>
  )
}

/** Everything a repository's changes can be compared with, grouped by what it is. */
function ComparisonPicker({
  runId,
  repo,
  live,
  pulls,
  onPick,
  children,
}: {
  runId: string
  repo: WorkspaceRepo
  live: boolean
  pulls: readonly RunPull[]
  onPick: (against: string) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const against = repo.comparison?.against ?? SESSION

  const ownPulls = pulls.filter(
    (run) => run.role === 'author' && run.pull.state === 'open' && repoOfPull([repo], run.pull),
  )

  const pick = (next: string) => {
    setOpen(false)
    onPick(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[min(380px,calc(100vw-24px))] p-1"
        role="menu"
        aria-label="What to compare with"
      >
        <div className="max-h-[min(520px,70vh)] overflow-y-auto">
          <Heading>This session</Heading>
          <Choice
            icon={<CircleDot />}
            title="All changes in this session"
            detail={`Since it started from ${repo.defaultBranch}, committed or not`}
            selected={against === SESSION}
            onSelect={() => pick(SESSION)}
          />
          <Choice
            icon={<CircleDashed />}
            title="Uncommitted changes"
            detail="Since the last commit"
            selected={against === 'uncommitted'}
            disabled={!live}
            onSelect={() => pick('uncommitted')}
          />
          {ownPulls.length > 0 ? (
            <>
              <Heading>Pull requests</Heading>
              {ownPulls.map((run) => {
                const value = pullComparison(run, repo)

                return (
                  <Choice
                    key={run.pull.number}
                    icon={<GitPullRequest />}
                    title={`#${run.pull.number} ${run.pull.title}`}
                    detail={`${shortRef(run.pull.headRef)} into ${shortRef(run.pull.baseRef)}`}
                    selected={against === value}
                    disabled={!live}
                    onSelect={() => pick(value)}
                  />
                )
              })}
            </>
          ) : null}
          {repo.commits && repo.commits.length > 0 ? (
            <>
              <Heading>Since a commit</Heading>
              {repo.commits.slice(0, 12).map((commit) => (
                <Choice
                  key={commit.sha}
                  icon={<GitCommitHorizontal />}
                  title={commit.subject || shortSha(commit.sha)}
                  detail={shortSha(commit.sha)}
                  selected={against === `ref:${commit.sha}`}
                  disabled={!live}
                  onSelect={() => pick(`ref:${commit.sha}`)}
                />
              ))}
            </>
          ) : null}
          <Heading>Compare with a branch</Heading>
          {live ? (
            <BranchChoices runId={runId} repo={repo} against={against} onPick={pick} />
          ) : (
            <p className="text-muted-foreground px-2 pb-2 text-[11.5px] text-pretty">
              The sandbox is asleep. Send a message to wake it, then compare with any branch.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A branch or commit named in a sentence. */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="bg-accent/60 text-foreground rounded px-1 py-px font-mono text-[10.5px]">
      {children}
    </code>
  )
}

/** A branch named in a sentence, shortened so the sentence stays a sentence. */
function Ref({ name }: { name: string }) {
  return (
    <Code>
      <RefName name={name} />
    </Code>
  )
}

/** A plain sentence saying exactly which changes are listed. */
function ComparisonSentence({ repo, shown }: { repo: WorkspaceRepo; shown: RunPull | undefined }) {
  const comparison = repo.comparison
  const parsed = parseComparison(comparison?.against ?? SESSION)
  const count = repo.changes.length

  const files = (
    <b className="text-foreground font-medium">
      {count} {count === 1 ? 'file' : 'files'}
    </b>
  )

  const base = comparison?.baseSha ? <Code>{shortSha(comparison.baseSha)}</Code> : null

  const split =
    comparison?.baseMode === 'tip'
      ? ' The two share no history in the sandbox, so this is measured from its latest commit.'
      : ''

  let text: ReactNode

  if (!comparison) {
    text = (
      <>
        {files} changed since the session started from <Ref name={repo.defaultBranch} />, as last
        saved.
      </>
    )
  } else if (shown) {
    text = (
      <>
        {files} in <b className="text-foreground font-medium">PR #{shown.pull.number}</b>:{' '}
        <Ref name={shown.pull.headRef} /> compared with <Ref name={shown.pull.baseRef} />
        {parsed?.kind === 'ref' ? ', including work not pushed yet' : ''}.{split}
      </>
    )
  } else if (parsed?.kind === 'uncommitted') {
    text = (
      <>
        {files} changed since the last commit
        {repo.head?.branch ? (
          <>
            {' '}
            on <Ref name={repo.head.branch} />
          </>
        ) : null}
        . None of it is in a commit yet.
      </>
    )
  } else if (parsed?.kind === 'ref') {
    const commit = repo.commits?.find((item) => item.sha.startsWith(parsed.ref))

    text = commit ? (
      <>
        {files} changed after <Code>{shortSha(commit.sha)}</Code> “{commit.subject}”, up to the
        working tree.
      </>
    ) : (
      <>
        {files} differ between this work and <Ref name={parsed.ref} />
        {base && comparison.baseMode === 'merge-base' ? (
          <>, counted from where they split at {base}</>
        ) : null}
        .{split}
      </>
    )
  } else if (parsed?.kind === 'range') {
    text = (
      <>
        {files} changed on <Ref name={parsed.head} /> since it split from <Ref name={parsed.base} />
        . Work not committed is not included.{split}
      </>
    )
  } else {
    text = (
      <>
        {files} changed since the session started from <Ref name={repo.defaultBranch} />
        {base ? <> at {base}</> : null}, committed or not.
      </>
    )
  }

  return <p className="text-muted-foreground text-[11.5px] leading-relaxed text-pretty">{text}</p>
}

/** How long the pointer rests on the line before it says more. Moving along it after that is instant. */
const RAIL_TIP_MS = 150

/** What a stop or a bracket on the line says when pointed at: what it is, then what pressing it does. */
function RailTip({
  heading,
  facts,
  action,
  side = 'bottom',
  children,
}: {
  heading: ReactNode
  facts?: ReactNode
  /** What pressing it does. Left out where it cannot be pressed. */
  action: string | null
  /** Which way it opens, so it does not cover the line it is about. */
  side?: 'top' | 'bottom'
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={RAIL_TIP_MS}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="grid max-w-64 gap-0.5 px-2.5 py-1.5">
        <span className="text-[11.5px] font-medium text-pretty">{heading}</span>
        {facts ? <span className="text-muted-foreground tabular-nums">{facts}</span> : null}
        {action ? <span className="text-muted-foreground/80 pt-0.5">{action}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The session's history as a line: where it started, each commit, and the working tree, with the
 * stretch being compared lit and each pull request bracketed over its commits. Each stop is a
 * button that compares from there. At rest a stop is a dot and a name; pointing at it, or
 * reaching it with the keyboard, says the rest and lights what pressing it would compare.
 */
function Rail({
  repo,
  pulls,
  live,
  onPick,
}: {
  repo: WorkspaceRepo
  pulls: readonly RunPull[]
  live: boolean
  onPick: (against: string) => void
}) {
  const now = useNow()
  const points = railPoints(repo)
  const span = railSpan(repo, points)
  const brackets = railBrackets(repo, points, pulls)
  const shown = pullShown(repo.comparison?.against ?? SESSION, pulls, repo)
  const parsed = parseComparison(repo.comparison?.against ?? SESSION)

  // The stop pointed at, so the line can show what pressing it would compare.
  const [aimed, setAimed] = useState<number | null>(null)

  const otherBase =
    parsed?.kind === 'ref' && !repo.commits?.some((c) => c.sha.startsWith(parsed.ref)) && !shown
      ? parsed.ref
      : null

  const describe = (
    point: RailPoint,
  ): {
    name: ReactNode
    heading: ReactNode
    facts?: ReactNode
    action: string
    said: string
  } => {
    if (point.kind === 'base') {
      return otherBase
        ? {
            name: <RefName name={otherBase} />,
            heading: otherBase,
            facts:
              repo.comparison?.baseMode === 'tip'
                ? 'Measured from its latest commit'
                : `The two split at ${shortSha(repo.comparison?.baseSha)}`,
            action: 'Press to compare every change in this session instead.',
            said: `Compared with ${otherBase}`,
          }
        : {
            name: repo.defaultBranch,
            heading: `Where the session started, on ${repo.defaultBranch}`,
            facts: shortSha(point.sha),
            action: 'Press to compare every change since.',
            said: `Where the session started, ${repo.defaultBranch} at ${shortSha(point.sha)}`,
          }
    }

    if (point.kind === 'commit') {
      const { commit } = point

      return {
        name: shortSha(point.sha),
        heading: commit.subject || shortSha(point.sha),
        facts: [shortSha(point.sha), relativeTime(commit.at, now), ...commit.branches.map(shortRef)]
          .filter(Boolean)
          .join(' · '),
        action: 'Press to compare changes after this commit.',
        said: `Commit ${shortSha(point.sha)}, ${commit.subject}`,
      }
    }

    return {
      name: point.dirty ? 'Uncommitted' : 'Working tree',
      heading: point.dirty ? 'The working tree has uncommitted work' : 'The working tree is clean',
      facts: repo.head?.branch ? `On ${shortRef(repo.head.branch)}` : undefined,
      action: 'Press to compare only changes not committed yet.',
      said: point.dirty ? 'Working tree, with uncommitted work' : 'Working tree, clean',
    }
  }

  const pickPoint = (point: RailPoint) => {
    if (point.kind === 'base') {
      onPick(SESSION)
    } else if (point.kind === 'commit') {
      onPick(`ref:${point.sha}`)
    } else {
      onPick('uncommitted')
    }
  }

  const columns = points.length
  const last = columns - 1

  /** Whether the stretch from one stop to the next is in the comparison, or would be if the stop pointed at were pressed. */
  const stretch = (from: number): 'lit' | 'aimed' | 'off' =>
    span !== null && from >= span.from && from < span.to
      ? 'lit'
      : aimed !== null && aimed < last && from >= aimed
        ? 'aimed'
        : 'off'

  const stretchClass = { lit: 'bg-ring', aimed: 'bg-ring/40', off: 'bg-foreground/12' }

  return (
    <div
      // The working tree is where the newest work is, so the line starts scrolled to it.
      ref={(viewport) => {
        if (viewport) {
          viewport.scrollLeft = viewport.scrollWidth
        }
      }}
      className="-mx-2.5 [scrollbar-width:thin] overflow-x-auto px-2.5 pb-1.5"
    >
      <div
        // Room above the line for the brackets and the whole of their labels.
        className="relative grid pt-[26px]"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(72px, 1fr))`,
          minWidth: columns * 72,
        }}
      >
        {brackets.map(({ run, from, to }) => {
          const on = shown?.pull.number === run.pull.number

          return (
            <div
              key={run.pull.number}
              className={cn(
                'pointer-events-none absolute top-[9px] h-[13px] rounded-t-md border border-b-0',
                on ? 'border-route-constraint' : 'border-route-constraint/45',
              )}
              style={{
                left: `calc(${((from + 1) / columns) * 100}% + 4px)`,
                width: `calc(${((to - from) / columns) * 100}% - 8px)`,
              }}
            >
              <RailTip
                heading={`#${run.pull.number} ${run.pull.title}`}
                facts={`${shortRef(run.pull.headRef)} into ${shortRef(run.pull.baseRef)}`}
                action={live ? 'Press to show what it changes.' : null}
                side="top"
              >
                <button
                  type="button"
                  disabled={!live}
                  onClick={() => onPick(pullComparison(run, repo))}
                  aria-label={`Show what pull request ${run.pull.number} changes`}
                  className={cn(
                    'focus-visible:ring-ring/50 pointer-events-auto absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border px-1.5 font-mono text-[10px] leading-[14px] transition-colors outline-none focus-visible:ring-2',
                    on
                      ? 'bg-route-constraint border-route-constraint text-background'
                      : 'bg-background border-route-constraint/60 text-route-constraint hover:border-route-constraint',
                  )}
                >
                  #{run.pull.number}
                </button>
              </RailTip>
            </div>
          )
        })}
        {points.map((point, index) => {
          const lit = span !== null && index > span.from && index <= span.to
          const edge = span !== null && index === span.from
          const { name, heading, facts, action, said } = describe(point)
          const pressable = live || point.kind === 'base'
          const aim = () => setAimed(pressable ? index : null)
          const rest = () => setAimed((current) => (current === index ? null : current))

          return (
            <RailTip
              key={point.kind === 'commit' ? point.sha : point.kind}
              heading={heading}
              facts={facts}
              action={pressable ? action : null}
            >
              <button
                type="button"
                aria-label={said}
                disabled={!pressable}
                onClick={() => pickPoint(point)}
                onPointerEnter={aim}
                onPointerLeave={rest}
                onFocus={aim}
                onBlur={rest}
                className="group focus-visible:ring-ring/50 relative flex min-w-0 flex-col items-center gap-1 rounded-md pb-0.5 outline-none focus-visible:ring-2 disabled:cursor-default"
              >
                <span className="relative h-3 w-full">
                  {index > 0 ? (
                    <span
                      aria-hidden
                      className={cn(
                        'absolute top-[5px] right-1/2 left-0 h-0.5 transition-colors duration-150',
                        stretchClass[stretch(index - 1)],
                      )}
                    />
                  ) : null}
                  {index < last ? (
                    <span
                      aria-hidden
                      className={cn(
                        'absolute top-[5px] right-0 left-1/2 h-0.5 transition-colors duration-150',
                        stretchClass[stretch(index)],
                      )}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className={cn(
                      'bg-background group-hover:shadow-ring/20 group-focus-visible:shadow-ring/20 absolute top-0 left-1/2 z-10 size-3 -translate-x-1/2 border-2 transition-shadow duration-150 group-hover:shadow-[0_0_0_3px] group-focus-visible:shadow-[0_0_0_3px]',
                      point.kind === 'base' ? 'rounded-[3px]' : 'rounded-full',
                      point.kind === 'worktree' && 'border-dashed',
                      point.kind === 'worktree' && point.dirty
                        ? 'border-status-waiting'
                        : edge || lit
                          ? 'border-ring'
                          : 'border-muted-foreground/60',
                      edge && 'bg-ring',
                    )}
                  />
                </span>
                <span
                  className={cn(
                    'group-hover:text-foreground max-w-full truncate px-1 text-[10.5px] leading-tight transition-colors duration-150',
                    point.kind !== 'worktree' && 'font-mono',
                    point.kind === 'worktree' && point.dirty
                      ? 'text-status-waiting'
                      : lit || edge
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                  )}
                >
                  {name}
                </span>
              </button>
            </RailTip>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Says which changes the tab lists for the active repository and lets that be changed: the
 * picker, how many files, a way back to every change, the sentence that spells it out and the
 * session's history drawn as a line. The details fold away for a narrow tab.
 */
export function ComparisonBar({
  runId,
  repo,
  live,
  pulls,
  pending,
  onPick,
}: {
  runId: string
  repo: WorkspaceRepo
  /** Whether the sandbox is awake, which every comparison but the session's own needs. */
  live: boolean
  pulls: readonly RunPull[]
  /** Set while a newly picked comparison is being measured. */
  pending: boolean
  onPick: (against: string) => void
}) {
  const against = repo.comparison?.against ?? SESSION
  const shown = pullShown(against, pulls, repo)
  const title = comparisonTitle(against, repo, pulls)
  const [folded, setFolded] = useState(false)
  const kind = parseComparison(against)?.kind ?? 'session'
  const error = repo.comparison?.error

  const icon = shown ? (
    <GitPullRequest className="text-route-constraint" />
  ) : kind === 'uncommitted' ? (
    <CircleDashed className="text-status-waiting" />
  ) : kind === 'ref' && title.startsWith('Since') ? (
    <GitCommitHorizontal />
  ) : kind === 'ref' || kind === 'range' ? (
    <GitBranch />
  ) : (
    <CircleDot className="text-ring" />
  )

  return (
    <div className="@container grid shrink-0 gap-2 border-b px-2.5 pt-2 pb-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <ComparisonPicker runId={runId} repo={repo} live={live} pulls={pulls} onPick={onPick}>
          <button
            type="button"
            title={title}
            className={cn(
              'focus-visible:ring-ring/50 bg-accent/40 hover:bg-accent flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none focus-visible:ring-2 [&_svg]:size-3.5 [&_svg]:shrink-0',
              PRESS,
            )}
          >
            {icon}
            <ComparisonName against={against} repo={repo} pulls={pulls} />
            {shown ? (
              <span className="text-muted-foreground min-w-0 truncate font-normal">
                {shown.pull.title}
              </span>
            ) : null}
            <ChevronDown className="text-muted-foreground" />
          </button>
        </ComparisonPicker>
        {against !== SESSION ? (
          <button
            type="button"
            onClick={() => onPick(SESSION)}
            title="Back to all changes in this session"
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-accent/60 focus-visible:ring-ring/50 flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] outline-none focus-visible:ring-2',
              PRESS,
            )}
          >
            <Undo2 aria-hidden className="size-3" />
            {/* In a narrow tab the arrow stands for the words, which stay for a screen reader. */}
            <span className="sr-only @min-[400px]:not-sr-only">Back to all changes</span>
          </button>
        ) : null}
        {/* Unfolded, the sentence below gives the count, so it is only said here when it is not there. */}
        {pending || folded || error ? (
          <span className="text-muted-foreground px-0.5 text-[11.5px] tabular-nums">
            {pending
              ? 'Measuring…'
              : `${repo.changes.length} ${repo.changes.length === 1 ? 'file' : 'files'}`}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {shown ? (
            <a
              href={shown.pull.url}
              target="_blank"
              rel="noreferrer"
              className="text-route-constraint focus-visible:ring-ring/50 flex items-center gap-1 rounded-sm text-[11.5px] outline-none hover:underline focus-visible:ring-2"
            >
              Open #{shown.pull.number}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => setFolded((value) => !value)}
            aria-expanded={!folded}
            aria-label={folded ? 'Show comparison details' : 'Hide comparison details'}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
          >
            <ChevronRight
              className={cn(
                'ease-snappy size-3.5 transition-transform duration-150',
                !folded && 'rotate-90',
              )}
            />
          </button>
        </span>
      </div>
      {error ? (
        <p
          role="alert"
          className="bg-destructive/10 text-destructive flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11.5px]"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {/* With nothing measured, the error says all there is to say. */}
      {folded || error ? null : (
        <>
          <ComparisonSentence repo={repo} shown={shown} />
          {shown && pullSync(shown.pull, repo) === 'unpushed' ? (
            <p className="bg-status-waiting/10 text-status-waiting flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11.5px]">
              <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              Some of this is not on GitHub yet. Reviewers of #{shown.pull.number} see an older
              version until the session pushes.
            </p>
          ) : null}
          {repo.comparison ? <Rail repo={repo} pulls={pulls} live={live} onPick={onPick} /> : null}
        </>
      )}
    </div>
  )
}
