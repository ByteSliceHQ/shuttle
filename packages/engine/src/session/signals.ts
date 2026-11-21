import { Schema } from 'effect'

import {
  AttachmentRefSchema,
  MessageAuthorSchema,
  MessageReferenceSchema,
  shuttleModule,
} from './scope'

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
    author: Schema.optional(MessageAuthorSchema),
    attachments: Schema.optional(Schema.Array(AttachmentRefSchema)),
    references: Schema.optional(Schema.Array(MessageReferenceSchema)),
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

/** Asks the session to propose a pull request of its work, as its PR button does. */
export const requestPullRequest = shuttleModule.signal({
  description: 'Open the publish gate for a pull request of the session work.',
  input: Schema.Struct({
    requestId: Schema.String,
    title: Schema.String,
    body: Schema.String,
    draft: Schema.Boolean,
    repo: Schema.optional(Schema.String),
    requestedBy: Schema.optional(Schema.String),
  }),
  build: (input) =>
    shuttleModule.input('pr.requested', input, {
      idempotencyKey: `shuttle-pr-request:${input.requestId}`,
    }),
})
