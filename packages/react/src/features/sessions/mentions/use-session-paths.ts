import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'

import type { SandboxPaths } from '@shuttle/api'
import { useRunStore } from '@swirls/looms/react'

import { useShuttleHost } from '../../../shuttle'
import { logTail, readPathEvents } from './path-events'
import { PathIndex, type PathMatch } from './search'

/**
 * The paths in a session's repositories, for the `@` menu, kept up to date from the session's
 * event log rather than read again on a timer.
 *
 * - The list is read when the menu first opens, and remembers where the log was when it was asked
 *   for.
 * - A file an agent writes after that is added in place, if it is new; editing one changes nothing.
 * - Anything in the log that may have changed the tree in a way it does not say (see
 *   `path-events.ts`) is part of the query's key, so the list is read again the next time the menu
 *   is open, with the old one shown until the new one arrives.
 * - Reading again sends the last listing's `etag`, and an unchanged tree is not sent back.
 * - Changes the log cannot see, such as files made in a terminal, are picked up when the list is
 *   older than `FALLBACK_STALE_MS`.
 *
 * The log is read only while the menu is open, so the message box does not draw again for every
 * event the session streams.
 */

/** How old a list may be before the menu reads it again regardless of the log, in milliseconds. */
const FALLBACK_STALE_MS = 5 * 60_000

/** A listing, with where the log was when it was asked for. */
type ListedPaths = SandboxPaths & { readonly seq: number }

export interface SessionPaths {
  readonly search: (query: string, limit: number) => PathMatch[]
  /** How many paths there are to search. */
  readonly size: number
  readonly status: 'reading' | 'failed' | 'ready'
  /** Whether a repository had more paths than were listed. */
  readonly truncated: boolean
}

export function useSessionPaths(runId: string, open: boolean): SessionPaths {
  const host = useShuttleHost()
  const store = useRunStore(runId)
  // The last listing, for its etag. Kept with its session: the message box can stay on screen
  // while it moves to another session, whose listing an etag from this one must never stand for.
  const lastListing = useRef<{ readonly runId: string; readonly listed: ListedPaths } | null>(null)

  // Read when the message box draws while the menu is open: each keystroke, not each event.
  const version = open ? store.version() : -1

  const logged = useMemo(
    () => (version < 0 ? null : readPathEvents(store.events(), runId)),
    [store, version, runId],
  )

  const paths = useQuery({
    queryKey: ['shuttle', 'mention-paths', runId, logged?.relistSeq ?? 0],
    queryFn: async (): Promise<ListedPaths> => {
      const seq = logTail(store.events())
      const previous = lastListing.current?.runId === runId ? lastListing.current.listed : null
      const answer = await host.client.sandbox.paths({ id: runId, etag: previous?.etag })

      const listed =
        answer.unchanged === true && previous !== null ? { ...previous, seq } : { ...answer, seq }

      lastListing.current = { runId, listed }

      return listed
    },
    enabled: open,
    staleTime: FALLBACK_STALE_MS,
    placeholderData: keepPreviousData,
  })

  const listing = paths.data
  const listed = useMemo(() => worktreePaths(listing), [listing])
  const index = useMemo(() => new PathIndex(listed), [listed])
  const known = useMemo(() => new Set(listed), [listed])

  // Files written since the list was read that it does not have yet.
  const added = useMemo(() => {
    const fresh = new Set<string>()

    for (const write of logged?.writes ?? []) {
      if (write.seq > (listing?.seq ?? Infinity) && !known.has(write.path)) {
        fresh.add(write.path)
      }
    }

    return [...fresh]
  }, [logged, listing, known])

  return useMemo(() => {
    const extra = new PathIndex(added)

    return {
      search: (query, limit) =>
        [...index.search(query, limit), ...extra.search(query, limit)]
          .toSorted((a, b) => b.score - a.score)
          .slice(0, limit),
      size: index.size + extra.size,
      status:
        paths.isError && listing === undefined
          ? 'failed'
          : listing === undefined
            ? 'reading'
            : 'ready',
      truncated: (listing?.repos ?? []).some((repo) => repo.truncated),
    }
  }, [index, added, paths.isError, listing])
}

/** Every path as the worktree names it: `<repository>/<path>`. */
function worktreePaths(data: SandboxPaths | undefined): string[] {
  return (data?.repos ?? []).flatMap((repo) => repo.files.map((file) => `${repo.name}/${file}`))
}
