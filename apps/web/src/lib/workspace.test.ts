import { describe, expect, test } from 'bun:test'

import type { AnyEventEnvelope } from '@swirls/looms/core'

import { emptyWorkspaceTree, workspaceTree } from './workspace'

function event(type: string, payload: object): AnyEventEnvelope {
  return { type, payload, seq: 1, id: 'e1', ts: 1 } as AnyEventEnvelope
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
  })
})
