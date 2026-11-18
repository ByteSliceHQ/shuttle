import { Predicate, Schema } from 'effect'

import { reflectModule } from './scope'

export const friction = reflectModule.projection({
  name: 'friction',
  shape: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        summary: Schema.String,
        runId: Schema.String,
        seq: Schema.Finite,
        threadId: Schema.optional(Schema.String),
      }),
    ),
  }),
  initialState: { entries: [] },
  reduce(state, event) {
    if (event.type === 'reflect.friction.recorded') {
      return { entries: [...state.entries, event.payload] }
    }

    if (event.type === 'agent.steered' && event.payload.interrupt === true) {
      const content = event.payload.message.content
      return {
        entries: [
          ...state.entries,
          {
            kind: 'correction',
            summary: Predicate.isString(content) ? content : 'interrupted steer',
            runId: event.runId,
            seq: event.seq,
            threadId: event.threadId ?? undefined,
          },
        ],
      }
    }

    if (event.type === 'agent.turn.stopped') {
      return {
        entries: [
          ...state.entries,
          {
            kind: 'stop',
            summary: 'User stopped an in-flight turn',
            runId: event.runId,
            seq: event.seq,
            threadId: event.threadId ?? undefined,
          },
        ],
      }
    }

    if (
      event.type === 'agent.tool.result' &&
      event.payload.error !== null &&
      event.payload.error !== ''
    ) {
      return {
        entries: [
          ...state.entries,
          {
            kind: 'tool_error',
            summary: `${event.payload.name}: ${event.payload.error}`,
            runId: event.runId,
            seq: event.seq,
            threadId: event.threadId ?? undefined,
          },
        ],
      }
    }

    return state
  },
})
