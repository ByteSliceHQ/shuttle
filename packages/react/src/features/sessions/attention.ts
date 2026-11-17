/**
 * Which sessions want the person back, for the desktop app's Dock badge and notifications.
 *
 * Only a person's own sessions count: ones they started or were added to. An organization's
 * public sessions are someone else's work, and are not theirs to be called back to.
 */
export interface AttentionSession {
  readonly runId: string
  readonly title: string
  readonly activity: string
  readonly archived: boolean
  readonly ownerId?: string | null
  readonly memberIds?: readonly string[]
}

export type AttentionKind = 'needs_input' | 'finished' | 'failed'

export interface AttentionChange {
  readonly runId: string
  readonly title: string
  readonly kind: AttentionKind
}

function isMine(session: AttentionSession, userId: string): boolean {
  return session.ownerId === userId || (session.memberIds?.includes(userId) ?? false)
}

function watched(
  sessions: Readonly<Record<string, AttentionSession>>,
  userId: string,
): AttentionSession[] {
  return Object.values(sessions).filter((session) => !session.archived && isMine(session, userId))
}

/** How many of the person's sessions are stopped, waiting for them. */
export function attentionCount(
  sessions: Readonly<Record<string, AttentionSession>>,
  userId: string,
  /** The session on screen, which they can already see. Null when the window is elsewhere. */
  watching: string | null,
): number {
  return watched(sessions, userId).filter(
    (session) =>
      session.runId !== watching &&
      (session.activity === 'needs_input' || session.activity === 'error'),
  ).length
}

/** What each watched session was doing, to compare the next reading against. */
export function activitySnapshot(
  sessions: Readonly<Record<string, AttentionSession>>,
  userId: string,
): Record<string, string> {
  return Object.fromEntries(
    watched(sessions, userId).map((session) => [session.runId, session.activity]),
  )
}

const ARRIVED: Record<string, AttentionKind> = {
  needs_input: 'needs_input',
  idle: 'finished',
  error: 'failed',
}

/**
 * Sessions that stopped working since `previous`. A session seen for the first time is not a
 * change: it was already in that state when the page opened.
 */
export function attentionChanges(
  previous: Readonly<Record<string, string>>,
  sessions: Readonly<Record<string, AttentionSession>>,
  userId: string,
): AttentionChange[] {
  return watched(sessions, userId).flatMap((session) => {
    const kind = ARRIVED[session.activity]

    return previous[session.runId] === 'working' && kind
      ? [{ runId: session.runId, title: session.title, kind }]
      : []
  })
}

const MESSAGES: Record<AttentionKind, string> = {
  needs_input: 'Needs your answer',
  finished: 'Finished working',
  failed: 'Stopped on an error',
}

export function attentionMessage(kind: AttentionKind): string {
  return MESSAGES[kind]
}
