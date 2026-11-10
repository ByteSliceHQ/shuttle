import { Schema } from 'effect'

import { agentCatalog } from '@swirls/looms/agent'
import { approvalCatalog } from '@swirls/looms/approval'
import { createModuleScope, defineEventCatalog } from '@swirls/looms/core'

const EvidenceSchema = Schema.Struct({
  runId: Schema.String,
  seq: Schema.Finite,
})

export const reflectCatalog = defineEventCatalog('reflect', {
  'friction.recorded': Schema.Struct({
    kind: Schema.String,
    summary: Schema.String,
    runId: Schema.String,
    seq: Schema.Finite,
    threadId: Schema.optional(Schema.String),
  }),
  'lesson.proposed': Schema.Struct({
    lessonId: Schema.String,
    text: Schema.String,
    scope: Schema.String,
    evidence: Schema.Array(EvidenceSchema),
    sourceRunId: Schema.String,
  }),
  'lesson.approved': Schema.Struct({
    lessonId: Schema.String,
  }),
  'lesson.rejected': Schema.Struct({
    lessonId: Schema.String,
  }),
  'lesson.retired': Schema.Struct({
    lessonId: Schema.String,
  }),
})

export const reflectModule = createModuleScope({
  namespace: 'reflect',
  protocolVersion: '1.0.0',
  description: 'Friction mining and playbook lessons over Looms event history.',
  events: reflectCatalog,
  observes: [agentCatalog, approvalCatalog],
})
