import type { MessageReferenceInput } from '@shuttle/api'

import { forbidden } from '../api/base'
import { personalWorkspaceRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { canOpenSession, type Actor } from '../tenancy/access'
import { parseRunId } from '../tenancy/run-id'
import { readListedSessions, type ListedSession } from '../workspace/listings'
import { BRIEF_CHARS, clip, REPLY_CHARS, type DigestSource } from './digest-source'
import type { MessageReference } from './scope'

/**
 * Turns what the message box picked after `@` into what the session records. A file keeps its
 * path. A session is checked (same organization, and one the sender may open) and read: its
 * title, goal and brief, and the last things its agents said, so the agents reading the message
 * know what it points at without being able to open it.
 *
 * Sending waits for this, so it reads as little as it can: the workspaces' listings once for the
 * whole message, and from each session only the few lines its digest needs (`getDigestSource`),
 * every session at the same time.
 */

export async function resolveReferences(
  env: ShuttleEnv,
  actor: Actor,
  runId: string,
  text: string,
  picked: readonly MessageReferenceInput[],
): Promise<MessageReference[]> {
  const unique = new Map<string, MessageReferenceInput>()

  for (const reference of picked) {
    const key =
      reference.kind === 'file' ? `file:${reference.path}` : `session:${reference.sessionId}`

    // The session the message is sent to is already what its agents are working on.
    if (!unique.has(key) && !(reference.kind === 'session' && reference.sessionId === runId)) {
      unique.set(key, reference)
    }
  }

  const references = [...unique.values()]

  const sessionIds = references.flatMap((reference) =>
    reference.kind === 'session' ? [reference.sessionId] : [],
  )

  const refused = forbidden('The message points at a session you cannot open')

  if (sessionIds.some((sessionId) => parseRunId(sessionId).orgId !== actor.orgId)) {
    throw refused
  }

  const listed =
    sessionIds.length === 0
      ? new Map<string, ListedSession>()
      : await readListedSessions(
          env,
          [
            personalWorkspaceRunId(env, actor.orgId, actor.userId),
            workspaceRunId(env, actor.orgId),
          ],
          sessionIds,
        )

  return Promise.all(
    references.map(async (reference): Promise<MessageReference> => {
      if (reference.kind === 'file') {
        return { kind: 'file', path: reference.path }
      }

      // Only a session the sender's workspaces list can be pointed at. That rules out every other
      // run in the organization (workspaces, the playbook, ids that name nothing), whose access
      // record is empty and so would pass the check below.
      const listing = listed.get(reference.sessionId)

      if (listing === undefined) {
        throw refused
      }

      const run = loomsStub(env.LOOMS_RUN, reference.sessionId)

      const [access, source] = await Promise.all([
        run.getAccess(),
        run.getDigestSource().catch((): DigestSource => ({ brief: '', replies: [] })),
      ])

      if (!canOpenSession(access, actor)) {
        throw refused
      }

      const resolved: Extract<MessageReference, { kind: 'session' }> = {
        kind: 'session',
        sessionId: reference.sessionId,
        title: listing.title,
        digest: sessionDigest({
          goal: listing.goal,
          status: listing.status,
          brief: source.brief,
          replies: source.replies,
        }),
      }

      // A label is how the conversation finds the mention, so it has to be in the text.
      const label = reference.label

      return label !== undefined && text.includes(`@${label}`) ? { ...resolved, label } : resolved
    }),
  )
}

/** What a referenced session says, in a few lines an agent can read. */
export function sessionDigest(input: {
  readonly goal: string
  readonly status: string | null
  readonly brief: string
  readonly replies: readonly string[]
}): string {
  const goal = input.goal.trim()
  const brief = input.brief.trim()
  const replies = input.replies.map((reply) => reply.trim()).filter((reply) => reply !== '')

  return [
    goal !== '' ? `Goal: ${goal}` : '',
    input.status !== null ? `Status: ${input.status}` : '',
    brief !== '' && brief !== goal ? `Brief:\n${clip(brief, BRIEF_CHARS)}` : '',
    replies.length > 0
      ? `Latest from its agents:\n${replies.map((reply) => clip(reply, REPLY_CHARS)).join('\n---\n')}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}
