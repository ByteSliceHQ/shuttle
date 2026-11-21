import { describe, expect, test } from 'bun:test'

import {
  buildConductorInput,
  initialConductor,
  markConductorDown,
  markConductorLive,
  queueForConductor,
  shouldSpawnConductor,
} from './conductor'

describe('conductor state', () => {
  test('starts ready to spawn and becomes live on spawn', () => {
    const starting = initialConductor()
    expect(shouldSpawnConductor(starting)).toBe(true)

    const live = markConductorLive(starting, 'thr_c')
    expect(live).toEqual({ status: 'live', threadId: 'thr_c', generation: 0 })
    expect(shouldSpawnConductor(live)).toBe(false)
  })

  test('markConductorDown is idempotent for a second delivery of the same failure', () => {
    const live = markConductorLive(initialConductor(), 'thr_c')
    const first = markConductorDown(live, 'thr_c', 'failed')
    const second = markConductorDown(first, 'thr_c', 'failed')

    expect(first).toEqual({
      status: 'down',
      generation: 1,
      reason: 'failed',
      queued: [],
    })

    expect(second).toBe(first)
    expect(shouldSpawnConductor(first)).toBe(false)
  })

  test('ignores terminal events for a different thread while live', () => {
    const live = markConductorLive(initialConductor(), 'thr_c')
    expect(markConductorDown(live, 'thr_other', 'failed')).toBe(live)
  })

  test('queues work while down and then wants a spawn', () => {
    const down = markConductorDown(
      markConductorLive(initialConductor(), 'thr_c'),
      'thr_c',
      'failed',
    )

    const queued = queueForConductor(down, { messageId: 'm1', text: 'add dark mode' })

    expect(shouldSpawnConductor(queued)).toBe(true)

    const prompt = buildConductorInput({
      runId: 'session_1',
      goal: 'Build a todo app',
      briefText: 'Build a todo app',
      briefVersion: 1,
      repoUrl: null,
      repos: [],
      lessons: [],
      playbookVersion: 0,
      conductor: queued,
    })

    expect(prompt).toContain('add dark mode')
    expect(prompt).toContain('Previous conductor ended (failed)')
    expect(prompt).toContain('cannot open pull requests')
  })

  test('points the conductor at session worktrees, not the shared clones', () => {
    const prompt = buildConductorInput({
      runId: 'session_1',
      goal: 'Add docs',
      briefText: 'Add docs',
      briefVersion: 1,
      repoUrl: null,
      repos: [
        {
          installationId: 1,
          owner: 'acme',
          name: 'glue',
          fullName: 'acme/glue',
          defaultBranch: 'main',
          private: true,
        },
      ],
      lessons: [],
      playbookVersion: 0,
      conductor: initialConductor(),
    })

    expect(prompt).toContain('acme/glue: /workspace/.wt/session_1/glue')
    expect(prompt).not.toContain('/workspace/repos/')
  })
})
