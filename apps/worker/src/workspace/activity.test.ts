import { describe, expect, test } from 'bun:test'

import type { EventEnvelope } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { createWorkspaceActivityProjector } from './activity'

describe('workspace activity projector', () => {
  test('coalesces a batch and skips the workspace run itself', async () => {
    const signals: unknown[] = []

    const env = {
      SHUTTLE_WORKSPACE_RUN_ID: 'shuttle-workspace',
      LOOMS_RUN: {
        getByName: () => ({
          signal: async (events: unknown[]) => {
            signals.push(...events)
          },
        }),
      },
      SANDBOX: {} as DurableObjectNamespace,
    } as unknown as ShuttleEnv

    const self = createWorkspaceActivityProjector(env, 'shuttle-workspace')

    await self.project([
      {
        type: 'agent.turn.started',
        seq: 1,
        ts: 10,
        payload: {},
      } as EventEnvelope,
    ])

    expect(signals).toHaveLength(0)

    const projector = createWorkspaceActivityProjector(env, 'session_abc')

    await projector.project([
      {
        type: 'agent.turn.started',
        seq: 1,
        ts: 10,
        payload: {},
      } as EventEnvelope,
      {
        type: 'approval.requested',
        seq: 2,
        ts: 20,
        payload: {},
      } as EventEnvelope,
    ])

    expect(signals).toHaveLength(1)

    const event = signals[0] as {
      type: string
      payload: { activity: string }
      idempotencyKey?: string
    }

    expect(event.type).toBe('workspace.session.activity')
    expect(event.payload.activity).toBe('needs_input')
    expect(event.idempotencyKey).toBe('activity:session_abc:2')
  })
})
