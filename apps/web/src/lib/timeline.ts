import { changedPaths } from './artifact-links'
import type { FeedItem } from './session-feed'

/** Thoughts shorter than this are routine and say nothing, so the timeline leaves them out. */
const BRIEF_THOUGHT_MS = 2000

/** A thread and the threads under it, as far as the timeline needs to know them. */
export interface TimelineThread {
  readonly threadId: string
  readonly children: readonly TimelineThread[]
}

/** Everything an agent and the agents under it did, folded into one row of the timeline. */
export interface DelegationRow {
  readonly kind: 'delegation'
  readonly id: string
  /** The delegated agent. Opening the row shows its own timeline. */
  readonly threadId: string
  readonly seq: number
  readonly ts: number
  /** How many agents the work involved: the delegated one and any it delegated to in turn. */
  readonly agents: number
  readonly toolCalls: number
  readonly failed: number
  readonly changedFiles: number
  /** The last thing the agent said. */
  readonly lastText?: string
}

export type TimelineRow = FeedItem | DelegationRow

/** Each thread's parent, with `null` for the root. */
export function threadParents(root: TimelineThread | null): ReadonlyMap<string, string | null> {
  const parents = new Map<string, string | null>()

  function visit(node: TimelineThread, parent: string | null) {
    parents.set(node.threadId, parent)

    for (const child of node.children) {
      visit(child, node.threadId)
    }
  }

  if (root) {
    visit(root, null)
  }

  return parents
}

/** The thread and its ancestors, nearest first, ending at the root. */
function lineage(threadId: string, parents: ReadonlyMap<string, string | null>): string[] {
  const chain: string[] = []
  let current: string | null | undefined = threadId

  while (current && !chain.includes(current)) {
    chain.push(current)
    current = parents.get(current)
  }

  return chain
}

/** The thread's ancestors from the top down, then the thread, leaving out the root. */
export function threadPath(
  threadId: string,
  parents: ReadonlyMap<string, string | null>,
): string[] {
  return lineage(threadId, parents)
    .filter((id) => parents.get(id) !== null)
    .toReversed()
}

/**
 * Whether a thread speaks for itself in a timeline, rather than being folded into a row or
 * left out.
 *
 * The session's top level keeps the session's own thread and the agents directly under it: the
 * one doing the work, and the ones that answer and route messages. An agent's own timeline
 * keeps that agent alone.
 *
 * @param openThreadId The agent whose timeline is open. Left out, it is the top level.
 */
export function threadSpeaks(
  threadId: string,
  parents: ReadonlyMap<string, string | null>,
  openThreadId?: string,
): boolean {
  if (openThreadId !== undefined) {
    return threadId === openThreadId
  }

  // A thread the tree has not reported yet is shown rather than lost.
  return !parents.has(threadId) || lineage(threadId, parents).length <= 2
}

function itemThreadId(item: FeedItem): string | undefined {
  return item.kind === 'user' ? undefined : item.threadId
}

/**
 * The rows a timeline shows: the session's top level, or one agent's own. Work by an agent that
 * does not speak in it is folded into one row for the agent it was delegated to, placed where
 * that work began.
 *
 * Questions for the reader are never folded at the top level: whoever asked, they need an
 * answer.
 */
export function projectTimeline(
  items: readonly FeedItem[],
  parents: ReadonlyMap<string, string | null>,
  openThreadId?: string,
): TimelineRow[] {
  const rows: TimelineRow[] = []
  const folded = new Map<string, { index: number; threads: Set<string> }>()
  const top = openThreadId === undefined

  for (const item of items) {
    const threadId = itemThreadId(item)

    if (threadId === undefined) {
      // Messages from people, and notices about the session, belong to the top level.
      if (top) {
        rows.push(item)
      }

      continue
    }

    // Questions need an answer and shared files are meant to be seen, whoever they came from.
    const surfaced = top && (item.kind === 'question' || item.kind === 'media')

    if (threadSpeaks(threadId, parents, openThreadId) || surfaced) {
      if (item.kind === 'thought' && (item.durationMs ?? 0) < BRIEF_THOUGHT_MS) {
        continue
      }

      rows.push(item)

      continue
    }

    // The agent this work was delegated to: the one just below a thread that speaks here.
    const chain = lineage(threadId, parents)

    const speaker = chain.findIndex(
      (id, index) => index > 0 && threadSpeaks(id, parents, openThreadId),
    )

    const delegate = speaker > 0 ? chain[speaker - 1] : undefined

    if (!delegate) {
      continue
    }

    let fold = folded.get(delegate)

    if (!fold) {
      fold = { index: rows.length, threads: new Set() }
      folded.set(delegate, fold)

      rows.push({
        kind: 'delegation',
        id: `delegation_${delegate}`,
        threadId: delegate,
        seq: item.seq,
        ts: item.ts,
        agents: 0,
        toolCalls: 0,
        failed: 0,
        changedFiles: 0,
      })
    }

    fold.threads.add(threadId)
    const row = rows[fold.index]

    if (row?.kind !== 'delegation') {
      continue
    }

    rows[fold.index] = {
      ...row,
      agents: fold.threads.size,
      ...(item.kind === 'tools'
        ? {
            toolCalls: row.toolCalls + item.calls.length,
            failed: row.failed + item.calls.filter((call) => call.status === 'error').length,
            changedFiles: row.changedFiles + changedPaths(item.calls).length,
          }
        : {}),
      ...(item.kind === 'agent' && threadId === delegate ? { lastText: item.text } : {}),
    }
  }

  return rows
}

/** Shorter messages than this ("Done.", "On it.") repeat naturally and are left alone. */
const MIN_REPEAT_LENGTH = 24

/**
 * The agent messages that say, word for word, what an earlier agent message in the session
 * already said. The conversation folds these to one line, so the same notice sent in answer to
 * several messages is read once.
 */
export function repeatedMessages(items: readonly FeedItem[]): ReadonlySet<string> {
  const said = new Set<string>()
  const repeats = new Set<string>()

  for (const item of items) {
    if (item.kind !== 'agent') {
      continue
    }

    const text = item.text.replace(/\s+/g, ' ').trim()

    if (text.length < MIN_REPEAT_LENGTH) {
      continue
    }

    if (said.has(text)) {
      repeats.add(item.id)
    } else {
      said.add(text)
    }
  }

  return repeats
}
