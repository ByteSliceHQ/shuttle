import { oc } from '@orpc/contract'
import { z } from 'zod'

import { Ok, SessionParams } from './common'
import {
  HarnessId,
  SessionHarness,
  SessionTeam,
  SessionVendorModels,
  Team,
  VendorModelChoice,
} from './harness'

export const SessionVisibility = z.enum(['private', 'public'])
export type SessionVisibility = z.infer<typeof SessionVisibility>

/**
 * Who can open a session. A private one opens for its owner and members only; a public one for
 * everyone in the organization. `canShare` says whether the caller may change any of this.
 */
export const SessionAccess = z.object({
  ownerId: z.string().nullable(),
  memberIds: z.array(z.string()).readonly(),
  visibility: SessionVisibility,
  canShare: z.boolean(),
})
export type SessionAccess = z.infer<typeof SessionAccess>

export const INTERJECTION_KINDS = [
  'question',
  'idea',
  'constraint',
  'correction',
  'task',
  'stop',
] as const

export const InterjectionKind = z.enum(INTERJECTION_KINDS)
export type InterjectionKind = z.infer<typeof InterjectionKind>

export const MAX_ATTACHMENTS = 10

export const AssetId = z.string().regex(/^ast_[0-9a-f]{32}$/)

export const LlmModel = z.object({ model: z.string() })
export type LlmModel = z.infer<typeof LlmModel>

const IndexedRun = z.record(z.string(), z.unknown())

export const PlaybookLesson = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.string(),
  evidence: z.array(z.object({ runId: z.string(), seq: z.number() })),
  sourceRunId: z.string(),
})
export type PlaybookLesson = z.infer<typeof PlaybookLesson>

export const PlaybookState = z.object({
  version: z.number(),
  lessons: z.array(PlaybookLesson),
  proposed: z.record(z.string(), PlaybookLesson.omit({ id: true })).optional(),
})
export type PlaybookState = z.infer<typeof PlaybookState>

export const sessionsContract = {
  list: oc
    .route({ method: 'GET', path: '/sessions' })
    .output(z.object({ sessions: z.array(IndexedRun), note: z.string().optional() })),

  tree: oc
    .route({ method: 'GET', path: '/sessions/{id}/tree' })
    .input(SessionParams)
    .output(
      z.object({ sessionId: z.string(), runs: z.array(IndexedRun), note: z.string().optional() }),
    ),

  access: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/access' })
      .input(SessionParams)
      .output(SessionAccess),

    /** Changes who a session is shared with, its visibility, or both. Owner only. */
    update: oc
      .route({ method: 'PUT', path: '/sessions/{id}/access' })
      .input(
        SessionParams.extend({
          memberIds: z.array(z.string().min(1).max(128)).optional(),
          visibility: SessionVisibility.optional(),
        }),
      )
      .output(SessionAccess),
  },

  /** Sends a person's message into a session. The author is taken from the sign-in. */
  say: oc
    .route({ method: 'POST', path: '/sessions/{id}/say' })
    .input(
      SessionParams.extend({
        /** Chosen by the sender, so the message can be shown before the session confirms it. */
        messageId: z.string().trim().min(1).max(128),
        text: z.string().default(''),
        forceKind: InterjectionKind.optional(),
        targetThreadId: z.string().optional(),
        /** Ids of files already uploaded to this session. */
        attachments: z.array(AssetId).max(MAX_ATTACHMENTS).default([]),
      }),
    )
    .output(z.object({ messageId: z.string() })),

  /** Asks the session for a pull request of its work. Answers with the publish card's id. */
  pullRequest: oc
    .route({ method: 'POST', path: '/sessions/{id}/pull-request' })
    .input(
      SessionParams.extend({
        title: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().optional(),
        repo: z.string().optional(),
      }),
    )
    .output(z.object({ approvalId: z.string() })),

  rename: oc
    .route({ method: 'POST', path: '/sessions/{id}/rename' })
    .input(SessionParams.extend({ title: z.string().trim().min(1).max(120) }))
    .output(z.object({ runId: z.string(), title: z.string() })),

  archive: oc
    .route({ method: 'POST', path: '/sessions/{id}/archive' })
    .input(SessionParams)
    .output(z.object({ runId: z.string(), archived: z.literal(true) })),

  /** Stops the turn an agent thread is in. */
  stop: oc
    .route({ method: 'POST', path: '/sessions/{id}/stop' })
    .input(SessionParams.extend({ threadId: z.string().trim().min(1) }))
    .output(Ok.extend({ threadId: z.string() })),

  /** Stops one agent thread in a session, and every thread beneath it. */
  stopThread: oc
    .route({ method: 'POST', path: '/sessions/{id}/threads/{threadId}/stop' })
    .input(SessionParams.extend({ threadId: z.string().min(1) }))
    .output(Ok.extend({ threadId: z.string() })),

  llmModel: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/llm-model' })
      .input(SessionParams)
      .output(LlmModel),
    set: oc
      .route({ method: 'PUT', path: '/sessions/{id}/llm-model' })
      .input(SessionParams.extend({ model: z.string().trim().min(1) }))
      .output(LlmModel),
  },

  harness: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/harness' })
      .input(SessionParams)
      .output(SessionHarness),
    set: oc
      .route({ method: 'PUT', path: '/sessions/{id}/harness' })
      .input(SessionParams.extend({ harness: HarnessId }))
      .output(SessionHarness),
  },

  team: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/team' })
      .input(SessionParams)
      .output(SessionTeam),
    set: oc
      .route({ method: 'PUT', path: '/sessions/{id}/team' })
      .input(SessionParams.extend({ team: Team }))
      .output(SessionTeam),
  },

  /** The model and effort each vendor agent runs on in this session. */
  vendorModels: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/vendor-models' })
      .input(SessionParams)
      .output(SessionVendorModels),
    set: oc
      .route({ method: 'PUT', path: '/sessions/{id}/vendor-models' })
      .input(SessionParams.extend({ harness: HarnessId }).extend(VendorModelChoice.shape))
      .output(SessionVendorModels),
  },
}

export const playbookContract = {
  get: oc
    .route({ method: 'GET', path: '/playbook' })
    .output(z.object({ runId: z.string(), playbook: PlaybookState, note: z.string().optional() })),

  /** Starts the organization's playbook run if it has not been started. */
  ensure: oc
    .route({ method: 'POST', path: '/playbook/ensure' })
    .output(z.object({ runId: z.string(), created: z.boolean(), status: z.string().optional() })),
}
