import { AtSign, FileText, MessagesSquare } from 'lucide-react'
import { useMemo } from 'react'

import { cn } from '../../../lib/cn'
import { compactRelativeTime } from '../../../lib/time'
import { useNow } from '../../../lib/use-now'
import { useOptionalWorkspace, useWorkspaceSessions } from '../../workspace/workspace-context'
import { matchesLabel, scoreLabel, sessionLabel } from './search'
import { useSessionPaths, type SessionPaths } from './use-session-paths'

/**
 * What the message box offers after `@`: the session's team members, the other sessions in the
 * workspace, and the files in the session's repositories.
 *
 * The files are read when the menu first opens and searched in the browser from then on; the
 * session's event log says when they need reading again (see `use-session-paths.ts`).
 */

export type MentionOption =
  | { readonly kind: 'agent'; readonly id: string; readonly label: string; readonly detail: string }
  | {
      readonly kind: 'session'
      readonly id: string
      readonly label: string
      readonly detail: string
    }
  | { readonly kind: 'file'; readonly id: string; readonly label: string; readonly detail: string }

export interface MentionGroup {
  readonly label: string
  readonly options: readonly MentionOption[]
}

const CLOSED: MentionOptions = { groups: [], options: [], filesNote: null }

/** How many of each the menu shows. */
const MAX_SESSIONS = 5
const MAX_FILES = 30

export interface MentionOptions {
  readonly groups: readonly MentionGroup[]
  /** Every option in the order the menu shows them, for moving through with the arrow keys. */
  readonly options: readonly MentionOption[]
  /** What to say under the list about the files: still reading, could not, or how many. */
  readonly filesNote: string | null
}

export function useMentionOptions({
  runId,
  query,
  open,
  agents,
}: {
  runId: string
  query: string
  open: boolean
  agents: readonly { id: string; label: string }[]
}): MentionOptions {
  const sessions = useWorkspaceSessions()
  const folders = useOptionalWorkspace()?.tree.folders
  const now = useNow(60_000)

  const paths = useSessionPaths(runId, open)

  return useMemo(() => {
    // Nothing is worked out while the menu is closed: the message box draws on every keystroke.
    if (!open) {
      return CLOSED
    }

    const groups: MentionGroup[] = []

    const agentOptions = agents
      .filter((agent) => matchesLabel(query, agent.id) || matchesLabel(query, agent.label))
      .map((agent): MentionOption => ({
        kind: 'agent',
        id: agent.id,
        label: agent.label,
        detail: `@${agent.id}`,
      }))

    if (agentOptions.length > 0) {
      groups.push({ label: 'Hand to', options: agentOptions })
    }

    const folderId = sessions[runId]?.folderId

    const sessionOptions = Object.values(sessions)
      .filter((session) => session.runId !== runId && !session.archived)
      .map((session) => {
        const label = sessionLabel(session.title, session.goal)
        // Matched against the whole title, of which the label may be only the start.
        const score = scoreLabel(query, session.title.trim() === '' ? session.goal : session.title)

        return { session, label, score }
      })
      .filter((candidate) => candidate.score >= 0)
      // Best match first. Among equal matches, and before anything is typed, sessions in this
      // one's folder first, then the most recently changed.
      .toSorted((a, b) => {
        const match = b.score - a.score

        const sameFolder =
          Number(b.session.folderId === folderId) - Number(a.session.folderId === folderId)

        return match !== 0
          ? match
          : sameFolder !== 0
            ? sameFolder
            : b.session.updatedAt - a.session.updatedAt
      })
      .slice(0, MAX_SESSIONS)
      .map(({ session, label }): MentionOption => ({
        kind: 'session',
        id: session.runId,
        label,
        // Where it is and how recent, so two sessions with the same title can be told apart.
        detail: [
          folders?.[session.folderId]?.name,
          compactRelativeTime(session.updatedAt, now),
          session.status,
        ]
          .filter((part) => part !== undefined && part !== '')
          .join(' · '),
      }))

    if (sessionOptions.length > 0) {
      groups.push({ label: 'Sessions', options: sessionOptions })
    }

    const fileOptions = paths.search(query, MAX_FILES).map(({ path }): MentionOption => {
      const slash = path.lastIndexOf('/')

      return {
        kind: 'file',
        id: path,
        label: path.slice(slash + 1),
        detail: slash === -1 ? '' : path.slice(0, slash),
      }
    })

    if (fileOptions.length > 0) {
      groups.push({ label: 'Files', options: fileOptions })
    }

    return {
      groups,
      options: groups.flatMap((group) => group.options),
      filesNote: describeFiles(paths, query),
    }
  }, [open, agents, sessions, folders, now, runId, query, paths])
}

function describeFiles(paths: SessionPaths, query: string): string {
  if (paths.status === 'failed') {
    return 'Could not read the files'
  }

  if (paths.status === 'reading') {
    return 'Reading files…'
  }

  const { size, truncated } = paths
  const count = `${size.toLocaleString()}${truncated ? '+' : ''} ${size === 1 && !truncated ? 'file' : 'files'}`

  return query === '' ? `Type to search ${count}` : `Searching ${count}`
}

const ICONS = { agent: AtSign, session: MessagesSquare, file: FileText } as const

/** The menu itself, drawn above the message box. The text box keeps the focus throughout. */
export function MentionMenu({
  id,
  groups,
  activeIndex,
  filesNote,
  onPick,
  onHover,
}: {
  id: string
  groups: readonly MentionGroup[]
  /** Position of the highlighted option among all of them, in the order they are shown. */
  activeIndex: number
  filesNote: string | null
  onPick: (option: MentionOption) => void
  onHover: (index: number) => void
}) {
  // Where each group's options start among all of them.
  const starts = groups.map((_, at) =>
    groups.slice(0, at).reduce((count, group) => count + group.options.length, 0),
  )

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Add to the message"
      className="bg-popover text-popover-foreground absolute inset-x-0 bottom-full z-20 mb-2 max-h-80 overflow-y-auto rounded-lg border p-1 shadow-lg shadow-black/20"
    >
      {groups.map((group, groupAt) => (
        <div key={group.label} role="group" aria-label={group.label}>
          <div className="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px] font-medium">
            {group.label}
          </div>
          {group.options.map((option, optionAt) => {
            const index = (starts[groupAt] ?? 0) + optionAt

            const Icon = ICONS[option.kind]
            const active = index === activeIndex

            return (
              <div
                key={`${option.kind}:${option.id}`}
                id={mentionOptionId(id, index)}
                role="option"
                aria-selected={active}
                ref={active ? scrollIntoViewIfNeeded : undefined}
                // Keeps the focus in the text box, so typing carries on after a click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(option)}
                onMouseMove={() => onHover(index)}
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[12.5px]',
                  active && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="shrink-0 truncate">{option.label}</span>
                <span className="text-muted-foreground min-w-0 truncate text-[11px]">
                  {option.detail}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {filesNote !== null ? (
        <div className="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px]">{filesNote}</div>
      ) : null}
    </div>
  )
}

/** The element id of the option at `index`, for `aria-activedescendant`. */
export function mentionOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

function scrollIntoViewIfNeeded(element: HTMLDivElement | null) {
  element?.scrollIntoView({ block: 'nearest' })
}
