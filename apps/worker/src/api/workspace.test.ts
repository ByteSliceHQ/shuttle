import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { FolderSyncReport, WorkspaceSnapshotResponse, WorkspaceTree } from '@shuttle/api'
import type { EventEnvelope, EventInput } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import type { FolderSyncReport as SyncReport } from '../pulls/folder-sync'
import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { sessionTabs, workspaceTree } from '../workspace/module'
import { handleApi } from './handler'

const actor: Actor = {
  userId: 'user1',
  orgId: 'org1',
  role: 'admin',
  name: 'Ada',
  email: 'ada@example.com',
}

const REPO = {
  installationId: 42,
  owner: 'acme',
  name: 'glue',
  fullName: 'acme/glue',
  defaultBranch: 'main',
  private: false,
}

function event(type: string, payload: object, ts: number, idempotencyKey?: string): EventEnvelope {
  return {
    type,
    payload,
    runId: 'o-org1-shuttle-workspace',
    seq: 1,
    id: `e-${ts}`,
    ts,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  } as EventEnvelope
}

/** A workspace with a folder, a linked repo, a session that has worked and settled, and tabs. */
const EVENTS = [
  event('workspace.folder.created', { folderId: 'f1', name: 'Shuttle', createdAt: 1_000 }, 1_000),
  event('workspace.folder.auto_review.set', { folderId: 'f1', autoReview: 'others' }, 1_100),
  event(
    'workspace.github.connected',
    { installationId: 42, account: { login: 'acme', type: 'Organization', avatarUrl: '' } },
    1_200,
  ),
  event('workspace.repo.linked', { folderId: 'f1', repo: REPO }, 1_300),
  event(
    'workspace.session.requested',
    { runId: 'o-org1-s1', folderId: 'f1', goal: 'Ship the sidebar', ownerId: 'user1' },
    2_000,
  ),
  event(
    'workspace.session.requested',
    { runId: 'o-org1-s2', folderId: 'f1', goal: 'By Shuttle' },
    2_100,
  ),
  event('workspace.session.launched', { runId: 'o-org1-s1' }, 3_000),
  event('workspace.session.shared', { runId: 'o-org1-s1', memberIds: ['user2'] }, 3_500),
  event(
    'workspace.session.activity',
    { runId: 'o-org1-s1', activity: 'idle', at: 4_000, seq: 12 },
    4_000,
  ),
  event(
    'workspace.session.listed',
    {
      runId: 'o-org1-s3',
      folderId: 'f1',
      goal: 'Shared with me',
      title: 'Shared',
      status: 'completed',
      activity: 'needs_input',
      createdAt: 500,
      updatedAt: 900,
      archived: true,
      ownerId: null,
      memberIds: ['user1'],
    },
    4_500,
  ),
  event(
    'workspace.tab.opened',
    { runId: 'o-org1-s1', tabId: 't1', kind: 'file', title: 'app.js', target: 'app.js', at: 5_000 },
    5_000,
  ),
  event(
    'workspace.tab.opened',
    { runId: 'o-org1-s1', tabId: 't2', kind: 'terminal', title: 'Terminal', target: '', at: 5_100 },
    5_100,
  ),
  event('workspace.tab.reordered', { runId: 'o-org1-s1', tabIds: ['t2', 't1'] }, 5_200),
]

const tree = EVENTS.reduce(
  (state, item) => workspaceTree.reduce(state, item as never),
  workspaceTree.initialState,
)

const tabs = EVENTS.reduce(
  (state, item) => sessionTabs.reduce(state, item as never),
  sessionTabs.initialState,
)

/** A workspace run that answers with the projections given and records what it is signalled. */
function fakeRuns(projections: Record<string, unknown>) {
  const signals: { runId: string; events: readonly EventInput[] }[] = []
  const access: Record<string, unknown> = {}

  const stub = (runId: string) => ({
    fetch: async (request: Request) => {
      const name = new URL(request.url).pathname.split('/').at(-1) ?? ''

      return name in projections
        ? Response.json({ value: projections[name] })
        : new Response('not found', { status: 404 })
    },
    getStreamTail: async () => 7,
    getRun: async () => ({ startIdentity: 'started' }),
    launch: async () => {},
    signal: async (events: readonly EventInput[]) => {
      signals.push({ runId, events })

      return {}
    },
    setAccess: async (value: unknown) => {
      access[runId] = value

      return value
    },
    getSessionActivitySnapshot: async () => null,
  })

  const env = fakeEnv({
    LOOMS_RUN: { getByName: stub } as unknown as ShuttleEnv['LOOMS_RUN'],
  })

  return { env, signals, access }
}

function call(env: ShuttleEnv, path: string, init?: RequestInit): Promise<Response | null> {
  return handleApi({
    env,
    actor,
    request: new Request(`https://worker.example.com${path}`, init),
  })
}

async function started(response: Response | null): Promise<{ runId: string }> {
  return z.object({ runId: z.string() }).parse(await response?.json())
}

function send(env: ShuttleEnv, method: string, path: string, body: unknown) {
  return call(env, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('workspace output schemas', () => {
  test('a tree and tabs folded from events pass through unchanged', () => {
    const snapshot = { runId: 'o-org1-shuttle-workspace', tail: 13, tree, tabs }

    expect(tree.sessions['o-org1-s1']?.lastCompletedAt).toBe(4_000)
    expect(tabs['o-org1-s1']?.order).toEqual(['t2', 't1'])

    expect(WorkspaceSnapshotResponse.parse({ ...snapshot, personal: snapshot })).toEqual({
      ...snapshot,
      personal: snapshot,
    })
  })

  test('a workspace that could not be read is a snapshot with nothing in it', () => {
    const empty = { runId: 'r', tail: 0, tree: null, tabs: null }

    expect(WorkspaceSnapshotResponse.parse({ ...empty, personal: empty })).toEqual({
      ...empty,
      personal: empty,
    })
  })

  test('records from before a field existed, or with fields since dropped, are still accepted', () => {
    const older = {
      folderOrder: ['f1'],
      folders: {
        f1: { folderId: 'f1', name: 'Old', createdAt: 1, archived: false, repos: [REPO] },
      },
      sessions: {
        s1: {
          runId: 's1',
          folderId: 'f1',
          title: 'Old session',
          goal: 'Old session',
          status: 'paused',
          activity: 'thinking',
          createdAt: 1,
          updatedAt: 2,
          archived: false,
          sandboxName: 'folder:f1',
        },
      },
      installations: {},
    }

    const parsed = WorkspaceTree.parse(older)

    expect(parsed.folders.f1?.autoReview).toBeUndefined()

    expect(parsed.sessions.s1).toEqual({
      runId: 's1',
      folderId: 'f1',
      title: 'Old session',
      goal: 'Old session',
      status: 'paused',
      activity: 'thinking',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    })
  })

  test('a folder sync report passes through unchanged', () => {
    const report: SyncReport = {
      folderId: 'f1',
      upserted: 3,
      repos: [
        {
          fullName: 'acme/glue',
          status: 'ok',
          open: 4,
          synced: 3,
          checksHidden: false,
          message: null,
        },
        {
          fullName: 'acme/api',
          status: 'forbidden',
          open: 0,
          synced: 0,
          checksHidden: false,
          message: 'The GitHub App cannot read pull requests in this repository.',
        },
      ],
      installations: [
        {
          installationId: 42,
          account: 'acme',
          missingPermissions: ['Checks'],
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/42',
        },
      ],
    }

    expect(FolderSyncReport.parse(report)).toEqual(report)
  })
})

describe('workspace routes', () => {
  test('GET /workspace answers with both workspaces as their runs project them', async () => {
    const { env } = fakeRuns({ workspaceTree: tree, sessionTabs: tabs })
    const response = await call(env, '/workspace')

    expect(response?.status).toBe(200)

    const snapshot = { tail: 7, tree: JSON.parse(JSON.stringify(tree)), tabs }

    expect(await response?.json()).toEqual({
      ...snapshot,
      runId: 'o-org1-shuttle-workspace',
      personal: { ...snapshot, runId: 'o-org1-member-user1-shuttle-workspace' },
    })
  })

  test('GET /workspace answers nulls for a workspace whose projections cannot be read', async () => {
    const { env } = fakeRuns({})
    const response = await call(env, '/workspace')

    expect(response?.status).toBe(200)

    expect(await response?.json()).toMatchObject({
      tree: null,
      tabs: null,
      personal: { tree: null },
    })
  })

  test('POST /workspace/sessions requests a private session with the folder’s repos', async () => {
    const { env, signals, access } = fakeRuns({ workspaceTree: tree })

    const response = await send(env, 'POST', '/workspace/sessions', {
      folderId: 'f1',
      goal: '  Fix the build  ',
    })

    expect(response?.status).toBe(200)

    const { runId } = await started(response)

    expect(runId).toStartWith('o-org1-session_')
    expect(access[runId]).toEqual({ ownerId: 'user1', memberIds: [], visibility: 'private' })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.runId).toBe('o-org1-member-user1-shuttle-workspace')

    expect(signals[0]?.events[0]).toMatchObject({
      payload: { runId, folderId: 'f1', goal: 'Fix the build', ownerId: 'user1', repos: [REPO] },
    })
  })

  test('POST /workspace/sessions refuses a missing goal and a malformed device id', async () => {
    const { env, signals } = fakeRuns({ workspaceTree: tree })

    const noGoal = await send(env, 'POST', '/workspace/sessions', { folderId: 'f1', goal: '  ' })

    expect(noGoal?.status).toBe(400)

    const badDevice = await send(env, 'POST', '/workspace/sessions', {
      folderId: 'f1',
      goal: 'Fix the build',
      deviceId: 'no',
    })

    expect(badDevice?.status).toBe(400)
    expect(await badDevice?.json()).toMatchObject({ error: 'Invalid device id' })
    expect(signals).toHaveLength(0)
  })

  test('DELETE /workspace/folders/{folderId}/repos reads the repository from the body', async () => {
    const { env, signals } = fakeRuns({ workspaceTree: tree })

    const response = await send(env, 'DELETE', '/workspace/folders/f1/repos', {
      fullName: 'acme/glue',
    })

    expect(response?.status).toBe(200)

    expect(await response?.json()).toEqual({
      folderId: 'f1',
      fullName: 'acme/glue',
      unlinked: true,
    })

    // The unlink itself, then the repository's review policy without this folder in it.
    expect(signals.map((item) => item.runId)).toEqual([
      'o-org1-shuttle-workspace',
      'o-org1-shuttle-pulls',
    ])

    expect(signals[0]?.events[0]).toMatchObject({
      payload: { folderId: 'f1', fullName: 'acme/glue' },
    })
  })

  test('a pull sync with no body names the folder in its path', async () => {
    const { env } = fakeRuns({ workspaceTree: tree })
    const response = await call(env, '/workspace/folders/nope/pulls/sync', { method: 'POST' })

    expect(response?.status).toBe(404)
    expect(await response?.json()).toMatchObject({ error: 'folder not found' })
  })

  test('a repository name is one path segment with its slash encoded', async () => {
    const { env } = fakeRuns({ workspaceTree: tree })

    const unlinked = await call(
      env,
      `/workspace/folders/f1/pulls/${encodeURIComponent('acme/other')}/8/threads/sync`,
      { method: 'POST' },
    )

    expect(unlinked?.status).toBe(404)

    expect(await unlinked?.json()).toMatchObject({
      error: 'repository is not linked to this folder',
    })

    const notANumber = await call(
      env,
      `/workspace/folders/f1/pulls/${encodeURIComponent('acme/glue')}/eight/threads/sync`,
      { method: 'POST' },
    )

    expect(notANumber?.status).toBe(400)
  })

  test('POST …/review starts a private review session linked to the pull request', async () => {
    const { env, signals, access } = fakeRuns({ workspaceTree: tree })
    const path = `/workspace/folders/f1/pulls/${encodeURIComponent('acme/glue')}/8/review`

    expect((await send(env, 'POST', path, { baseSha: 'bbb' }))?.status).toBe(400)

    const response = await send(env, 'POST', path, { headSha: 'aaa', baseSha: 'bbb' })

    expect(response?.status).toBe(200)

    const { runId } = await started(response)

    expect(access[runId]).toEqual({ ownerId: 'user1', memberIds: [], visibility: 'private' })

    expect(signals.map((item) => item.runId)).toEqual([
      'o-org1-member-user1-shuttle-workspace',
      'o-org1-shuttle-pulls',
    ])

    expect(signals[0]?.events[0]).toMatchObject({
      payload: {
        runId,
        goal: 'Review acme/glue#8',
        definitionName: 'review',
        repos: [REPO],
        pull: { fullName: 'acme/glue', number: 8, headSha: 'aaa', baseSha: 'bbb' },
      },
    })

    expect(signals[1]?.events[0]).toMatchObject({
      payload: { fullName: 'acme/glue', number: 8, runId },
    })
  })
})
