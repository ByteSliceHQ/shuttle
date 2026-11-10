import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { codingSession, shuttleSession } from '../session/module'
import {
  archiveFolder,
  closeTab,
  createFolder,
  linkRepo,
  openTab,
  reorderTabs,
  requestSession,
  retargetTab,
  sessionTabs,
  unlinkRepo,
  workspace,
  workspaceDefinition,
  workspaceTree,
} from './module'

const TextInput = z.object({
  text: z.string().optional(),
})

const stubConductor = defineAgent({
  name: 'conductor',
  input: TextInput,
  instructions: 'Conduct.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'ok' },
    done: true,
    output: { ok: true },
  }),
})

const stubNarrator = defineAgent({
  name: 'narrator',
  input: TextInput,
  instructions: 'Narrate.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'ok' },
    done: true,
    output: { ok: true },
  }),
})

const stubWorker = defineAgent({
  name: 'worker',
  input: TextInput,
  instructions: 'Work.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'ok' },
    done: true,
    output: { ok: true },
  }),
})

const stubReflector = defineAgent({
  name: 'reflector',
  input: TextInput,
  instructions: 'Reflect.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'ok' },
    done: true,
    output: { ok: true },
  }),
})

describe('workspace module', () => {
  test('creates folders, links repos, and launches a session once', async () => {
    const looms = createLooms({
      modules: [
        agent({ definitions: [stubConductor, stubNarrator, stubWorker, stubReflector] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession] }),
        workspace(),
      ],
    })

    try {
      const { runId } = await looms.launchRun({
        kind: 'shuttle-workspace',
        definitionName: workspaceDefinition.name,
        input: { title: 'Test workspace' },
      })

      await looms.signal(runId, [
        createFolder({
          folderId: 'folder-1',
          name: 'Shuttle',
          createdAt: 1,
        }),
        linkRepo({
          folderId: 'folder-1',
          repo: {
            installationId: 42,
            owner: 'byteslicehq',
            name: 'shuttle',
            fullName: 'byteslicehq/shuttle',
            defaultBranch: 'main',
            private: false,
          },
        }),
        requestSession({
          runId: 'session_1',
          folderId: 'folder-1',
          goal: 'Ship the sidebar',
          lessons: [],
          playbookVersion: 0,
          playbookRunId: null,
        }),
      ])

      let tree = await looms.project(runId, workspaceTree)

      for (let i = 0; i < 50 && tree.sessions['session_1']?.status !== 'running'; i++) {
        await sleep(20)
        tree = await looms.project(runId, workspaceTree)
      }

      expect(tree.folders['folder-1']?.name).toBe('Shuttle')
      expect(tree.folders['folder-1']?.repos).toHaveLength(1)
      expect(tree.sessions['session_1']?.title).toBe('Ship the sidebar')
      expect(tree.sessions['session_1']?.status).toBe('running')

      const session = await looms.getRun('session_1')
      expect(session.status).toBeTruthy()

      // Unlink must not affect the already-launched session.
      await looms.signal(runId, [
        unlinkRepo({ folderId: 'folder-1', fullName: 'byteslicehq/shuttle' }),
      ])

      for (let i = 0; i < 20; i++) {
        await sleep(10)
        tree = await looms.project(runId, workspaceTree)

        if (tree.folders['folder-1']?.repos.length === 0) {
          break
        }
      }

      expect(tree.folders['folder-1']?.repos).toHaveLength(0)
      expect(tree.sessions['session_1']).toBeTruthy()

      await looms.signal(runId, [archiveFolder({ folderId: 'folder-1' })])

      for (let i = 0; i < 20; i++) {
        await sleep(10)
        tree = await looms.project(runId, workspaceTree)

        if (tree.folders['folder-1']?.archived) {
          break
        }
      }

      expect(tree.folders['folder-1']?.archived).toBe(true)
    } finally {
      await looms.stop()
    }
  })

  test('opens, closes, reorders, and retargets session tabs', async () => {
    const looms = createLooms({
      modules: [
        agent({ definitions: [stubConductor, stubNarrator, stubWorker, stubReflector] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession] }),
        workspace(),
      ],
    })

    try {
      const { runId } = await looms.launchRun({
        kind: 'shuttle-workspace',
        definitionName: workspaceDefinition.name,
        input: { title: 'Tabs workspace' },
      })

      await looms.signal(runId, [
        openTab({
          runId: 'session_tabs',
          tabId: 'events',
          kind: 'events',
          title: 'Events',
          target: '',
          at: 1,
        }),
        openTab({
          runId: 'session_tabs',
          tabId: 'files',
          kind: 'files',
          title: 'Files',
          target: '',
          at: 2,
        }),
        openTab({
          runId: 'session_tabs',
          tabId: 'browser',
          kind: 'browser',
          title: 'Browser',
          target: '3000',
          at: 3,
        }),
      ])

      let tabs = await looms.project(runId, sessionTabs)

      for (let i = 0; i < 50 && !tabs.session_tabs; i++) {
        await sleep(20)
        tabs = await looms.project(runId, sessionTabs)
      }

      expect(tabs.session_tabs?.order).toEqual(['events', 'files', 'browser'])
      expect(tabs.session_tabs?.tabs.browser?.target).toBe('3000')

      // Duplicate open is a no-op via idempotency + reducer guard.
      await looms.signal(runId, [
        openTab({
          runId: 'session_tabs',
          tabId: 'events',
          kind: 'events',
          title: 'Events',
          target: '',
          at: 99,
        }),
      ])

      await looms.signal(runId, [
        reorderTabs({
          runId: 'session_tabs',
          tabIds: ['browser', 'events', 'files'],
        }),
        retargetTab({
          runId: 'session_tabs',
          tabId: 'browser',
          title: 'Localhost',
          target: 'http://127.0.0.1:3000',
        }),
        closeTab({ runId: 'session_tabs', tabId: 'files' }),
      ])

      for (let i = 0; i < 50; i++) {
        await sleep(20)
        tabs = await looms.project(runId, sessionTabs)

        if (
          tabs.session_tabs?.order.length === 2 &&
          tabs.session_tabs.tabs.browser?.title === 'Localhost'
        ) {
          break
        }
      }

      expect(tabs.session_tabs?.order).toEqual(['browser', 'events'])
      expect(tabs.session_tabs?.tabs.files).toBeUndefined()
      expect(tabs.session_tabs?.tabs.browser?.target).toBe('http://127.0.0.1:3000')
      expect(Object.keys(tabs.session_tabs?.tabs ?? {})).toHaveLength(2)
    } finally {
      await looms.stop()
    }
  })
})
