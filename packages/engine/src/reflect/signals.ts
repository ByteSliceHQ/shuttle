import { Schema } from 'effect'

import { reflectModule } from './scope'

const EvidenceSchema = Schema.Struct({
  runId: Schema.String,
  seq: Schema.Finite,
})

export const proposeLesson = reflectModule.signal({
  description: 'Propose a playbook lesson from a reflection run.',
  input: Schema.Struct({
    lessonId: Schema.String,
    text: Schema.String,
    scope: Schema.String,
    evidence: Schema.Array(EvidenceSchema),
    sourceRunId: Schema.String,
  }),
  build: (input) =>
    reflectModule.input('lesson.proposed', input, {
      idempotencyKey: `reflect-lesson:${input.lessonId}`,
    }),
})

export const retireLesson = reflectModule.signal({
  description: 'Retire an approved playbook lesson.',
  input: Schema.Struct({
    lessonId: Schema.String,
  }),
  build: (input) => reflectModule.input('lesson.retired', input),
})
