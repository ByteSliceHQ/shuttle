import { ORPCError } from '@orpc/server'

import { PlaybookState } from '@shuttle/api'
import { headAsset, type AssetRef } from '@shuttle/engine/assets/store'
import { playbookRunId, workspaceRunId } from '@shuttle/engine/config'
import { isVendorHarness } from '@shuttle/engine/harness'
import { loomsStub } from '@shuttle/engine/looms-stub'
import { requestPullRequest, say } from '@shuttle/engine/session/signals'
import { parseTeam } from '@shuttle/engine/team'
import {
  canShareSession,
  isPublicSession,
  type Actor,
  type SessionAccess,
} from '@shuttle/engine/tenancy/access'
import { scopedRunId } from '@shuttle/engine/tenancy/run-id'
import { vendorHarnessInfo } from '@shuttle/engine/vendor/harnesses'
import { parseVendorModelChoice } from '@shuttle/engine/vendor/models'
import { archiveSession, renameSession } from '@shuttle/engine/workspace/module'
import {
  codeStorageClient,
  codeStorageConfigured,
  deleteScratchRepo,
  scratchRepoName,
} from '@shuttle/git/codestorage/client'
import { ACTOR_HEADER } from '@swirls/looms/runtime'

import { getAuth } from '../auth/auth'
import type { ShuttleEnv } from '../env'
import { resolveReferences } from '../session/resolve-references'
import { moveListings, signalListings } from '../workspace/listings'
import { api, badRequest, forbidden, notFound } from './base'

const sessions = api.sessions

function describeAccess(current: SessionAccess | null, actor: Actor) {
  return {
    ownerId: current?.ownerId ?? null,
    memberIds: current?.memberIds ?? [],
    visibility: isPublicSession(current) ? ('public' as const) : ('private' as const),
    canShare: canShareSession(current, actor),
  }
}

/** A session's vendor model choices. Its own win; without one it runs on the most recent made anywhere. */
async function vendorModelChoices(env: ShuttleEnv, orgId: string, runId: string) {
  const session = loomsStub(env.LOOMS_RUN, runId)
  const workspace = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))

  return {
    choices: {
      ...(await workspace.getVendorModelChoices()).choices,
      ...(await session.getVendorModelChoices()).choices,
    },
  }
}

export const sessionsRouter = {
  list: sessions.list.handler(async ({ context: { env, actor } }) => {
    if (!env.REPLICA) {
      return {
        sessions: [],
        note: 'D1 REPLICA is not configured. Start sessions normally; the list populates after you bind D1.',
      }
    }

    // Every run id in an organization starts with the same prefix.
    const orgPrefix = scopedRunId(actor.orgId, '')

    const result = await env.REPLICA.prepare(
      `SELECT run_id, kind, definition_name, status, correlation_id, updated_at, attributes_json
       FROM looms_run_index
       WHERE (kind = 'shuttle-session' OR definition_name = 'coding')
         AND substr(run_id, 1, ?) = ?
       ORDER BY updated_at DESC
       LIMIT 50`,
    )
      .bind(orgPrefix.length, orgPrefix)
      .all()

    return { sessions: result.results }
  }),

  tree: sessions.tree.handler(async ({ input, context: { env } }) => {
    if (!env.REPLICA) {
      return { sessionId: input.id, runs: [], note: 'D1 REPLICA is not configured.' }
    }

    const result = await env.REPLICA.prepare(
      `SELECT run_id, kind, definition_name, status, parent_run_id, correlation_id, updated_at
       FROM looms_run_index
       WHERE correlation_id = ? OR run_id = ? OR parent_run_id = ?
       ORDER BY updated_at DESC
       LIMIT 100`,
    )
      .bind(input.id, input.id, input.id)
      .all()

    return { sessionId: input.id, runs: result.results }
  }),

  access: {
    get: sessions.access.get.handler(async ({ input, context: { env, actor } }) =>
      describeAccess(await loomsStub(env.LOOMS_RUN, input.id).getAccess(), actor),
    ),

    update: sessions.access.update.handler(async ({ input, context: { env, actor, request } }) => {
      const session = loomsStub(env.LOOMS_RUN, input.id)
      const access = await session.getAccess()

      if (!access || !canShareSession(access, actor)) {
        throw forbidden('Only the session owner can change this')
      }

      const memberIds = input.memberIds ?? access.memberIds
      const visibility = input.visibility ?? access.visibility

      // A session can only be shared with people in its organization.
      const { members } = await getAuth(env).api.listMembers({
        headers: request.headers,
        query: { organizationId: actor.orgId, limit: 1000 },
      })

      const inOrg = new Set(members.map((member) => member.userId))

      if (!memberIds.every((id) => inOrg.has(id))) {
        throw badRequest('Everyone must be in this organization')
      }

      const saved = await session.setAccess({ ownerId: access.ownerId, memberIds, visibility })

      // The access record is the one that is enforced; the listings follow it.
      await moveListings(env, actor.orgId, input.id, access, saved)

      return describeAccess(saved, actor)
    }),
  },

  say: sessions.say.handler(async ({ input, context: { env, actor } }) => {
    // A message may be files alone.
    if (
      input.text.trim() === '' &&
      input.attachments.length === 0 &&
      input.references.length === 0
    ) {
      throw badRequest('messageId and text are required')
    }

    // The browser names files by id only. What each one is comes from the store, which also
    // proves it was uploaded to this session.
    const attachments: AssetRef[] = []

    for (const id of new Set(input.attachments)) {
      const asset = env.ASSETS ? await headAsset(env.ASSETS, input.id, id) : null

      if (!asset) {
        throw badRequest('An attached file is no longer available. Attach it again.')
      }

      attachments.push(asset)
    }

    // Each session the message points at is checked and read now, as it stands when it is sent.
    const references = await resolveReferences(env, actor, input.id, input.text, input.references)

    const message = say({
      messageId: input.messageId,
      text: input.text,
      forceKind: input.forceKind,
      targetThreadId: input.targetThreadId === '' ? undefined : input.targetThreadId,
      author: { id: actor.userId, name: actor.name === '' ? actor.email : actor.name },
      attachments: attachments.length > 0 ? attachments : undefined,
      references: references.length > 0 ? references : undefined,
    })

    // Answered once the message is on the log. The browser shows it from the event stream, and
    // waiting for the turn it starts would hold this request, and the next message, for minutes.
    await loomsStub(env.LOOMS_RUN, input.id).signal(
      [{ ...message, origin: { type: 'external', actorId: actor.userId } }],
      { wake: 'schedule' },
    )

    return { messageId: input.messageId }
  }),

  /**
   * The PR button. The session opens the same publish card an agent's proposal does, so nothing
   * is published until someone approves it. With no title, Shuttle writes one from the commits,
   * or the session goal.
   */
  pullRequest: sessions.pullRequest.handler(async ({ input, context: { env, actor } }) => {
    const requestId = crypto.randomUUID()
    const repo = (input.repo ?? '').trim().slice(0, 200)

    await loomsStub(env.LOOMS_RUN, input.id).signal([
      {
        ...requestPullRequest({
          requestId,
          title: (input.title ?? '').trim().slice(0, 300),
          body: (input.body ?? '').trim().slice(0, 20_000),
          draft: input.draft !== false,
          repo: repo === '' ? undefined : repo,
          requestedBy: actor.userId,
        }),
        origin: { type: 'external', actorId: actor.userId },
      },
    ])

    return { approvalId: `pr_publish_${requestId}` }
  }),

  /** Renames a session wherever it is listed. Anyone who can open the session may. */
  rename: sessions.rename.handler(async ({ input, context: { env, actor } }) => {
    const access = await loomsStub(env.LOOMS_RUN, input.id).getAccess()

    await signalListings(env, actor.orgId, access, [
      renameSession({ runId: input.id, title: input.title }),
    ])

    return { runId: input.id, title: input.title }
  }),

  archive: sessions.archive.handler(async ({ input, context: { env, actor } }) => {
    const access = await loomsStub(env.LOOMS_RUN, input.id).getAccess()

    await signalListings(env, actor.orgId, access, [archiveSession({ runId: input.id })])

    // An archived session is finished with. If it had a repository of its own on Code Storage,
    // only there to carry it between sandboxes, that goes too.
    if (codeStorageConfigured(env)) {
      await deleteScratchRepo(codeStorageClient(env), scratchRepoName(actor.orgId, input.id)).catch(
        (cause: unknown) => {
          console.warn('could not delete the scratch repository', cause)
        },
      )
    }

    return { runId: input.id, archived: true as const }
  }),

  stop: sessions.stop.handler(async ({ input, context: { env } }) => {
    await loomsStub(env.LOOMS_RUN, input.id).signal([
      {
        type: 'agent.turn.stopped',
        threadId: input.threadId,
        payload: {},
        idempotencyKey: `ui-stop:${input.threadId}:${Date.now()}`,
      },
    ])

    return { ok: true as const, threadId: input.threadId }
  }),

  /**
   * Stops one agent thread and every thread beneath it, the way Looms cancels a subtree. The
   * session itself keeps going: a stopped conductor is started again by the next task.
   *
   * The session's own thread cannot be stopped this way. Cancelling it ends the session for
   * good, which is not what a stop button on an agent means.
   */
  stopThread: sessions.stopThread.handler(async ({ input, context: { env, actor } }) => {
    const stub = loomsStub(env.LOOMS_RUN, input.id)
    const run = await stub.getRun()

    if (!run.threads[input.threadId]) {
      throw notFound('No such agent in this session')
    }

    if (input.threadId === run.rootThreadId) {
      throw badRequest('The session itself cannot be stopped')
    }

    const response = await stub.fetch(
      new Request(`https://shuttle.internal/runs/${encodeURIComponent(input.id)}/cancel`, {
        method: 'POST',
        // Recorded as the person who pressed stop.
        headers: { 'content-type': 'application/json', [ACTOR_HEADER]: actor.userId },
        body: JSON.stringify({ threadId: input.threadId }),
      }),
    )

    if (!response.ok) {
      throw new ORPCError('BAD_GATEWAY', {
        message: `Could not stop the agent: ${(await response.text()).slice(0, 300)}`,
      })
    }

    return { ok: true as const, threadId: input.threadId }
  }),

  llmModel: {
    get: sessions.llmModel.get.handler(({ input, context: { env } }) =>
      loomsStub(env.LOOMS_RUN, input.id).getLlmModel(),
    ),
    set: sessions.llmModel.set.handler(({ input, context: { env } }) =>
      loomsStub(env.LOOMS_RUN, input.id).setLlmModel(input.model),
    ),
  },

  harness: {
    get: sessions.harness.get.handler(({ input, context: { env } }) =>
      loomsStub(env.LOOMS_RUN, input.id).getHarness(),
    ),
    set: sessions.harness.set.handler(({ input, context: { env } }) =>
      loomsStub(env.LOOMS_RUN, input.id).setHarness(input.harness),
    ),
  },

  team: {
    get: sessions.team.get.handler(({ input, context: { env } }) =>
      loomsStub(env.LOOMS_RUN, input.id).getTeam(),
    ),
    set: sessions.team.set.handler(async ({ input, context: { env } }) => {
      const stub = loomsStub(env.LOOMS_RUN, input.id)
      // The shape is checked at the edge; this settles what a team must always hold true.
      const saved = await stub.setTeam(parseTeam(input.team))

      // The change takes effect on the conductor's next turn. Put it in the session's history so
      // "was Codex on the team when I asked?" can be answered from the events.
      await stub
        .signal([
          {
            type: 'shuttle.team.changed',
            payload: { ...saved.team },
            idempotencyKey: `team:${crypto.randomUUID()}`,
          },
        ])
        .catch(() => {})

      return saved
    }),
  },

  vendorModels: {
    get: sessions.vendorModels.get.handler(({ input, context: { env, actor } }) =>
      vendorModelChoices(env, actor.orgId, input.id),
    ),
    set: sessions.vendorModels.set.handler(async ({ input, context: { env, actor } }) => {
      const { harness } = input
      const choice = parseVendorModelChoice(input)

      if (!isVendorHarness(harness) || !vendorHarnessInfo(harness).supported || !choice) {
        throw badRequest('unknown agent or invalid model')
      }

      await loomsStub(env.LOOMS_RUN, input.id).setVendorModelChoice(harness, choice)

      // Remembered as the starting point for sessions that have not picked a model.
      await loomsStub(env.LOOMS_RUN, workspaceRunId(env, actor.orgId)).setVendorModelChoice(
        harness,
        choice,
      )

      return vendorModelChoices(env, actor.orgId, input.id)
    }),
  },
}

const emptyPlaybook: PlaybookState = { version: 0, lessons: [], proposed: {} }

export const playbookRouter = {
  get: api.playbook.get.handler(async ({ context: { env, actor } }) => {
    const runId = playbookRunId(env, actor.orgId)

    const response = await loomsStub(env.LOOMS_RUN, runId).fetch(
      new Request(`https://shuttle.internal/runs/${runId}/projections/activePlaybook`),
    )

    if (response.ok) {
      const body = PlaybookState.safeParse(
        (await response.json<{ value?: unknown }>()).value ?? emptyPlaybook,
      )

      return { runId, playbook: body.success ? body.data : emptyPlaybook }
    }

    return {
      runId,
      playbook: emptyPlaybook,
      note: 'Playbook run not started yet. POST /playbook/ensure first.',
    }
  }),

  ensure: api.playbook.ensure.handler(async ({ context: { env, actor } }) => {
    const runId = playbookRunId(env, actor.orgId)
    const stub = loomsStub(env.LOOMS_RUN, runId)

    try {
      const status = await stub.status()

      if (status) {
        return { runId, status: status.status, created: false }
      }
    } catch {
      // Not started yet.
    }

    await stub.launch({
      kind: 'reflect-playbook',
      definitionName: 'playbook',
      input: { title: 'Shuttle playbook' },
    })

    return { runId, created: true }
  }),
}
