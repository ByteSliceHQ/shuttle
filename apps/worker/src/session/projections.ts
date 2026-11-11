import { Schema } from 'effect'

import { shuttleModule } from './scope'

export { work } from './work-projection'

const LessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.optional(Schema.String),
})

export const brief = shuttleModule.projection({
  name: 'brief',
  shape: Schema.Struct({
    version: Schema.Finite,
    text: Schema.String,
  }),
  initialState: { version: 0, text: '' },
  reduce(state, event) {
    if (event.type === 'shuttle.brief.amended') {
      return { version: event.payload.version, text: event.payload.text }
    }

    if (event.type === 'runtime.thread.started') {
      const input = event.payload.input

      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const goal = (input as { goal?: unknown }).goal

        if (typeof goal === 'string') {
          return { version: 1, text: goal }
        }
      }
    }

    return state
  },
})

export const routing = shuttleModule.projection({
  name: 'routing',
  shape: Schema.Struct({
    chips: Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        kind: Schema.String,
        summary: Schema.String,
        targetThreadId: Schema.NullOr(Schema.String),
        briefVersion: Schema.optional(Schema.Finite),
      }),
    ),
  }),
  initialState: { chips: [] },
  reduce(state, event) {
    if (event.type !== 'shuttle.routed') {
      return state
    }

    return {
      chips: [
        ...state.chips,
        {
          messageId: event.payload.messageId,
          kind: event.payload.kind,
          summary: event.payload.summary,
          targetThreadId: event.payload.targetThreadId,
          briefVersion: event.payload.briefVersion,
        },
      ],
    }
  },
})

export const transcript = shuttleModule.projection({
  name: 'transcript',
  shape: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        role: Schema.Union([
          Schema.Literal('user'),
          Schema.Literal('assistant'),
          Schema.Literal('system'),
        ]),
        text: Schema.String,
        threadId: Schema.optional(Schema.String),
      }),
    ),
    playbookVersion: Schema.Finite,
    lessons: Schema.Array(LessonSchema),
  }),
  initialState: { messages: [], playbookVersion: 0, lessons: [] },
  reduce(state, event) {
    if (event.type === 'shuttle.user.said') {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: event.payload.messageId,
            role: 'user' as const,
            text: event.payload.text,
          },
        ],
      }
    }

    if (event.type === 'agent.message' && event.payload.message.role === 'assistant') {
      const content = event.payload.message.content
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            messageId: `${event.id}`,
            role: 'assistant' as const,
            text,
            threadId: event.threadId ?? undefined,
          },
        ],
      }
    }

    if (event.type === 'shuttle.playbook.loaded') {
      return {
        ...state,
        playbookVersion: event.payload.version,
        lessons: event.payload.lessons,
      }
    }

    return state
  },
})
