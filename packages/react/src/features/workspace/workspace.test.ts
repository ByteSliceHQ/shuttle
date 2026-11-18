import { describe, expect, test } from 'bun:test'

import type { AnyEventEnvelope, JsonValue } from '@swirls/looms/core'

import { emptySessionTabs, emptyWorkspaceTree, sessionTabs, workspaceTree } from './workspace'

function event(type: string, payload: JsonValue, idempotencyKey?: string): AnyEventEnvelope {
  const envelope: AnyEventEnvelope = {
    type,
    payload,
    seq: 1,
    id: 'e1',
    runId: 'run_test',
    ts: 1,
    threadId: null,
    origin: { type: 'system' },
  }

  if (idempotencyKey !== undefined && idempotencyKey !== '') {
    envelope.idempotencyKey = idempotencyKey
  }

  return envelope
}

describe('workspaceTree reducer', () => {
  test('folds folders, repos, and sessions', () => {
    let state = emptyWorkspaceTree

    state = workspaceTree.reduce(
      state,
      event('workspace.folder.created', {
        folderId: 'f1',
        name: 'Shuttle',
        createdAt: 1,
      }),
    )

    state = workspaceTree.reduce(
      state,
      event('workspace.repo.linked', {
        folderId: 'f1',
        repo: {
          installationId: 1,
          owner: 'byteslicehq',
          name: 'shuttle',
          fullName: 'byteslicehq/shuttle',
          defaultBranch: 'main',
          private: false,
        },
      }),
    )

    state = workspaceTree.reduce(
      state,
      event('workspace.session.requested', {
        runId: 's1',
        folderId: 'f1',
        goal: 'Build sidebar',
      }),
    )

    state = workspaceTree.reduce(state, event('workspace.session.launched', { runId: 's1' }))

    state = workspaceTree.reduce(
      state,
      event('workspace.session.activity', {
        runId: 's1',
        activity: 'needs_input',
        at: 99,
      }),
    )

    expect(state.folderOrder).toEqual(['f1'])
    expect(state.folders.f1?.repos[0]?.fullName).toBe('byteslicehq/shuttle')
    expect(state.sessions.s1?.activity).toBe('needs_input')
    expect(state.sessions.s1?.status).toBe('running')

    state = workspaceTree.reduce(
      state,
      event('workspace.session.activity', {
        runId: 's1',
        activity: 'working',
        at: 120,
      }),
    )

    state = workspaceTree.reduce(
      state,
      event('workspace.session.activity', {
        runId: 's1',
        activity: 'idle',
        at: 180,
      }),
    )

    state = workspaceTree.reduce(
      state,
      event('workspace.session.renamed', {
        runId: 's1',
        title: 'Refactored sidebar',
      }),
    )

    expect(state.sessions.s1?.activity).toBe('idle')
    expect(state.sessions.s1?.lastCompletedAt).toBe(180)
    expect(state.sessions.s1?.title).toBe('Refactored sidebar')
  })

  test('ignores out-of-order stale activity signals from projector backfills', () => {
    let state = emptyWorkspaceTree

    state = workspaceTree.reduce(
      state,
      event('workspace.folder.created', {
        folderId: 'f1',
        name: 'Demo 2',
        createdAt: 1,
      }),
    )

    state = workspaceTree.reduce(
      state,
      event('workspace.session.requested', {
        runId: 's_demo',
        folderId: 'f1',
        goal: 'are you able to see any files?',
      }),
    )

    state = workspaceTree.reduce(state, event('workspace.session.launched', { runId: 's_demo' }))

    // Projector v2 already reported idle at seq 588.
    state = workspaceTree.reduce(
      state,
      event(
        'workspace.session.activity',
        { runId: 's_demo', activity: 'idle', at: 1794366642408 },
        'activity:s_demo:588',
      ),
    )

    expect(state.sessions.s_demo?.activity).toBe('idle')
    expect(state.sessions.s_demo?.activitySeq).toBe(588)

    // Later projector version replays batch 1..500 (out of 588) and emits a stale working signal at seq 500.
    state = workspaceTree.reduce(
      state,
      event(
        'workspace.session.activity',
        { runId: 's_demo', activity: 'working', at: 1794366636601, seq: 500 },
        'activity:s_demo:500',
      ),
    )

    expect(state.sessions.s_demo?.activity).toBe('idle')
    expect(state.sessions.s_demo?.activitySeq).toBe(588)

    // Subsequent genuine user message advances past seq 588 -> updates to working.
    state = workspaceTree.reduce(
      state,
      event(
        'workspace.session.activity',
        { runId: 's_demo', activity: 'working', at: 1794367000000, seq: 595 },
        'activity:s_demo:595',
      ),
    )

    expect(state.sessions.s_demo?.activity).toBe('working')
    expect(state.sessions.s_demo?.activitySeq).toBe(595)
  })
})

describe('sessionTabs reducer', () => {
  test('opens, retargets, reorders, and closes tabs', () => {
    let state = emptySessionTabs

    state = sessionTabs.reduce(
      state,
      event('workspace.tab.opened', {
        runId: 's1',
        tabId: 'events',
        kind: 'events',
        title: 'Events',
        target: '',
        at: 1,
      }),
    )

    state = sessionTabs.reduce(
      state,
      event('workspace.tab.opened', {
        runId: 's1',
        tabId: 'browser',
        kind: 'browser',
        title: 'Browser',
        target: '3000',
        at: 2,
      }),
    )

    state = sessionTabs.reduce(
      state,
      event('workspace.tab.retargeted', {
        runId: 's1',
        tabId: 'browser',
        title: 'App',
        target: 'http://localhost:3000',
      }),
    )

    state = sessionTabs.reduce(
      state,
      event('workspace.tab.reordered', {
        runId: 's1',
        tabIds: ['browser', 'events'],
      }),
    )

    state = sessionTabs.reduce(
      state,
      event('workspace.tab.closed', { runId: 's1', tabId: 'events' }),
    )

    expect(state.s1?.order).toEqual(['browser'])
    expect(state.s1?.tabs.browser?.title).toBe('App')
    expect(state.s1?.tabs.events).toBeUndefined()
  })
})
