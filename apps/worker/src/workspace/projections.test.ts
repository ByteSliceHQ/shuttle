import { describe, expect, test } from 'bun:test'

import type { EventEnvelope } from '@swirls/looms/core'

import { workspaceTree } from './projections'

function event(type: string, payload: object, ts: number, idempotencyKey?: string): EventEnvelope {
  return {
    type,
    payload,
    seq: 1,
    id: `e-${ts}`,
    ts,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  } as EventEnvelope
}

function launchedSession() {
  let state = workspaceTree.initialState

  state = workspaceTree.reduce(
    state,
    event('workspace.folder.created', { folderId: 'f1', name: 'Shuttle', createdAt: 1_000 }, 1_000),
  )

  state = workspaceTree.reduce(
    state,
    event(
      'workspace.session.requested',
      { runId: 's1', folderId: 'f1', goal: 'Ship the sidebar' },
      2_000,
    ),
  )

  return workspaceTree.reduce(state, event('workspace.session.launched', { runId: 's1' }, 3_000))
}

describe('workspaceTree timestamps', () => {
  test('session timestamps come from event.ts, not wall clock', () => {
    const state = workspaceTree.reduce(
      launchedSession(),
      event('workspace.session.renamed', { runId: 's1', title: 'Sidebar polish' }, 4_000),
    )

    expect(state.sessions.s1?.createdAt).toBe(2_000)
    expect(state.sessions.s1?.updatedAt).toBe(4_000)
  })

  test('reconcile corrections settle activity without advancing updatedAt', () => {
    const state = workspaceTree.reduce(
      launchedSession(),
      event(
        'workspace.session.activity',
        { runId: 's1', activity: 'idle', at: 9_000, seq: 10 },
        9_000,
        'reconcile:s1:10:idle',
      ),
    )

    expect(state.sessions.s1?.activity).toBe('idle')
    expect(state.sessions.s1?.updatedAt).toBe(3_000)
    expect(state.sessions.s1?.lastCompletedAt).toBe(3_000)
  })
})
