import { Schema } from 'effect'

import { agentCatalog } from '@swirls/looms/agent'
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

export const shuttleCatalog = defineEventCatalog('shuttle', {
  'user.said': Schema.Struct({
    messageId: Schema.String,
    text: Schema.String,
    forceKind: Schema.optional(InterjectionKindSchema),
    targetThreadId: Schema.optional(Schema.String),
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
  'turn.thinking_delta': Schema.Struct({
    turn: Schema.Finite,
    delta: Schema.String,
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
  observes: [agentCatalog, evaluatorCatalog],
})
