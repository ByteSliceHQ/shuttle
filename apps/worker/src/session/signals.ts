import { Schema } from 'effect'

import { shuttleModule } from './scope'

const InterjectionKindSchema = Schema.Union([
  Schema.Literal('question'),
  Schema.Literal('idea'),
  Schema.Literal('constraint'),
  Schema.Literal('correction'),
  Schema.Literal('task'),
  Schema.Literal('stop'),
])

export const say = shuttleModule.signal({
  description: 'Send a user interjection into the Shuttle session mailbox.',
  input: Schema.Struct({
    messageId: Schema.String,
    text: Schema.String,
    forceKind: Schema.optional(InterjectionKindSchema),
    targetThreadId: Schema.optional(Schema.String),
  }),
  build: (input) =>
    shuttleModule.input('user.said', input, {
      idempotencyKey: `shuttle-say:${input.messageId}`,
    }),
})

export const reroute = shuttleModule.signal({
  description: 'Override intake routing for a prior user message.',
  input: Schema.Struct({
    messageId: Schema.String,
    kind: InterjectionKindSchema,
    targetThreadId: Schema.optional(Schema.String),
  }),
  build: (input) => shuttleModule.input('reroute', input),
})
