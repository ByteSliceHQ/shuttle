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
  createFolder,
  linkRepo,
  requestSession,
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
})
