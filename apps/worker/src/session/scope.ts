import { Schema } from 'effect'

import { agentCatalog } from '@swirls/looms/agent'
import { approvalCatalog } from '@swirls/looms/approval'
import { createModuleScope, defineEventCatalog } from '@swirls/looms/core'
import { evaluatorCatalog } from '@swirls/looms/evaluator'

const LessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.optional(Schema.String),
})

const InterjectionKindSchema = Schema.Union([
  Schema.Literal('question'),
  Schema.Literal('idea'),
  Schema.Literal('constraint'),
  Schema.Literal('correction'),
  Schema.Literal('task'),
  Schema.Literal('stop'),
])

/** The person a message came from. */
export const MessageAuthorSchema = Schema.Struct({ id: Schema.String, name: Schema.String })

export type MessageAuthor = Schema.Schema.Type<typeof MessageAuthorSchema>

/** A file attached to a message. The bytes are in the session's media store under `id`. */
export const AttachmentRefSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Finite,
})

export type AttachmentRef = Schema.Schema.Type<typeof AttachmentRefSchema>

export const shuttleCatalog = defineEventCatalog('shuttle', {
  'user.said': Schema.Struct({
    messageId: Schema.String,
    text: Schema.String,
    forceKind: Schema.optional(InterjectionKindSchema),
    targetThreadId: Schema.optional(Schema.String),
    /** Who sent the message. Set by the Worker from the sign-in, never by the browser. */
    author: Schema.optional(MessageAuthorSchema),
    /** Files sent with the message. The Worker has checked that each is stored for this session. */
    attachments: Schema.optional(Schema.Array(AttachmentRefSchema)),
  }),
  'intake.started': Schema.Struct({
    messageId: Schema.String,
    childThreadId: Schema.String,
  }),
  'intake.bypassed': Schema.Struct({
    messageId: Schema.String,
    kind: InterjectionKindSchema,
    targetThreadId: Schema.NullOr(Schema.String),
    text: Schema.String,
  }),
  routed: Schema.Struct({
    messageId: Schema.String,
    kind: InterjectionKindSchema,
    targetThreadId: Schema.NullOr(Schema.String),
    summary: Schema.String,
    briefVersion: Schema.optional(Schema.Finite),
    /** True when the route held this message for the next conductor spawn. */
    queued: Schema.optional(Schema.Boolean),
  }),
  'brief.amended': Schema.Struct({
    version: Schema.Finite,
    text: Schema.String,
    sourceMessageId: Schema.String,
  }),
  'playbook.loaded': Schema.Struct({
    version: Schema.Finite,
    lessons: Schema.Array(LessonSchema),
  }),
  'narrator.spawned': Schema.Struct({
    messageId: Schema.String,
    childThreadId: Schema.String,
  }),
  'conductor.spawned': Schema.Struct({
    childThreadId: Schema.String,
    generation: Schema.optional(Schema.Finite),
    reason: Schema.optional(
      Schema.Union([
        Schema.Literal('initial'),
        Schema.Literal('failed'),
        Schema.Literal('cancelled'),
        Schema.Literal('completed'),
      ]),
    ),
  }),
  'reflection.launched': Schema.Struct({
    runId: Schema.String,
  }),
  'sandbox.bound': Schema.Struct({
    sandboxName: Schema.String,
    repoCount: Schema.Finite,
  }),
  /**
   * Someone asked, from the session's PR button, for a pull request of the session's work. The
   * session opens the same publish gate an agent's proposal does.
   */
  'pr.requested': Schema.Struct({
    requestId: Schema.String,
    /** Empty to have Shuttle write one from the commits. */
    title: Schema.String,
    body: Schema.String,
    draft: Schema.Boolean,
    repo: Schema.optional(Schema.String),
    /** Who pressed the button. Set by the Worker from the sign-in. */
    requestedBy: Schema.optional(Schema.String),
  }),
  'pr.proposed': Schema.Struct({
    approvalId: Schema.String,
    title: Schema.String,
    body: Schema.String,
    draft: Schema.Boolean,
    repos: Schema.Array(Schema.String),
    /** Repo name for the layer being published; empty means all linked repos (legacy). */
    repo: Schema.optional(Schema.String),
    /** Independent stack within the repo; absent means stack 1 (legacy). */
    stackId: Schema.optional(Schema.Finite),
    layer: Schema.optional(Schema.Finite),
    parentPull: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          fullName: Schema.String,
          number: Schema.Finite,
        }),
      ),
    ),
    /** PR numbers that will be force-updated because a lower layer changed. */
    restacks: Schema.optional(Schema.Array(Schema.Finite)),
  }),
  'pr.published': Schema.Struct({
    approvalId: Schema.String,
    /** Agent thread that proposed the PRs. */
    threadId: Schema.optional(Schema.NullOr(Schema.String)),
    pulls: Schema.Array(
      Schema.Struct({
        fullName: Schema.String,
        number: Schema.Finite,
        url: Schema.String,
        draft: Schema.Boolean,
        outcome: Schema.optional(
          Schema.Union([
            Schema.Literal('opened'),
            Schema.Literal('updated'),
            Schema.Literal('unchanged'),
          ]),
        ),
        layer: Schema.optional(Schema.Finite),
      }),
    ),
    repo: Schema.optional(Schema.String),
    /** Independent stack within the repo; absent means stack 1 (legacy). */
    stackId: Schema.optional(Schema.Finite),
    layers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          layer: Schema.Finite,
          branch: Schema.String,
          parentBranch: Schema.String,
          pull: Schema.NullOr(
            Schema.Struct({
              number: Schema.Finite,
              url: Schema.String,
              draft: Schema.Boolean,
            }),
          ),
          remoteSha: Schema.String,
          publishedTree: Schema.String,
        }),
      ),
    ),
    stack: Schema.optional(
      Schema.Union([
        Schema.Struct({
          number: Schema.Finite,
          url: Schema.String,
        }),
        Schema.Struct({
          error: Schema.String,
        }),
      ]),
    ),
  }),
  'pr.publish_failed': Schema.Struct({
    approvalId: Schema.String,
    error: Schema.String,
  }),
  /** The user rejected the publish gate; settles the proposing tool call. */
  'pr.discarded': Schema.Struct({
    approvalId: Schema.String,
    message: Schema.String,
  }),
  'review.comment.drafted': Schema.Struct({
    commentId: Schema.String,
    path: Schema.String,
    line: Schema.Finite,
    side: Schema.Union([Schema.Literal('LEFT'), Schema.Literal('RIGHT')]),
    severity: Schema.Union([
      Schema.Literal('info'),
      Schema.Literal('warning'),
      Schema.Literal('error'),
    ]),
    body: Schema.String,
    suggestion: Schema.optional(Schema.String),
  }),
  'review.submitted': Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    verdict: Schema.Union([
      Schema.Literal('approve'),
      Schema.Literal('request_changes'),
      Schema.Literal('comment'),
    ]),
    commentCount: Schema.Finite,
    /** Comments whose line GitHub would not accept, sent in the review's body instead. */
    unanchoredCount: Schema.optional(Schema.Finite),
  }),
  /** GitHub refused the review, or it could not be sent. Nothing was posted. */
  'review.submit_failed': Schema.Struct({
    approvalId: Schema.String,
    error: Schema.String,
  }),
  'turn.thinking_delta': Schema.Struct({
    turn: Schema.Finite,
    delta: Schema.String,
  }),
  // What a vendor agent (Codex, Claude Code) did during a turn inside the sandbox. Looms does
  // not run these steps; they are recorded so the session shows the agent's work. Each is sent
  // live as it happens and again, durably, when the turn ends.
  // The session's work was carried from one sandbox to another: between a person's machine and
  // the cloud, or between two people's sandboxes. Recorded so the history shows where each
  // stretch of work happened.
  'sandbox.moved': Schema.Struct({
    from: Schema.Union([Schema.Literal('local'), Schema.Literal('cloud')]),
    to: Schema.Union([Schema.Literal('local'), Schema.Literal('cloud')]),
    /** The machine's name, for whichever end is one. */
    device: Schema.optional(Schema.String),
    /** True when the work came from the last save because the machine could not be reached. */
    fromSave: Schema.Boolean,
  }),
  // The developer changed who the conductor may delegate to. Recorded so the session history
  // shows when an agent joined or left the team.
  'team.changed': Schema.Struct({
    workers: Schema.Boolean,
    codex: Schema.Boolean,
    claudeCode: Schema.Boolean,
    // Optional so team-change events recorded before Cursor was a teammate still validate.
    cursor: Schema.optional(Schema.Boolean),
    preset: Schema.String,
  }),
  'vendor.turn_started': Schema.Struct({
    turn: Schema.Finite,
    harness: Schema.String,
    label: Schema.String,
    model: Schema.optional(Schema.String),
    /** The person whose sign-in the turn runs on. */
    billedTo: Schema.optional(Schema.String),
  }),
  'vendor.message': Schema.Struct({
    turn: Schema.Finite,
    text: Schema.String,
  }),
  'vendor.tool_started': Schema.Struct({
    turn: Schema.Finite,
    toolCall: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.String),
    }),
  }),
  'vendor.tool_finished': Schema.Struct({
    turn: Schema.Finite,
    toolCallId: Schema.String,
    result: Schema.String,
    error: Schema.optional(Schema.String),
  }),
  'turn.thought': Schema.Struct({
    turn: Schema.Finite,
    text: Schema.String,
    durationMs: Schema.optional(Schema.Finite),
  }),
  reroute: Schema.Struct({
    messageId: Schema.String,
    kind: InterjectionKindSchema,
    targetThreadId: Schema.optional(Schema.String),
  }),
})

export const shuttleModule = createModuleScope({
  namespace: 'shuttle',
  protocolVersion: '1.0.0',
  description: 'Coding session mailbox, brief, and interjection router.',
  events: shuttleCatalog,
  observes: [agentCatalog, evaluatorCatalog, approvalCatalog],
})
