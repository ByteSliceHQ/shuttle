import { deterministicThreadId } from '@swirls/looms/core'

import { worktreeRepoPath } from '../sandbox/workspace'
import type { LinkedSessionRepo, PendingMessage } from './thread'

export type ConductorEndReason = 'failed' | 'cancelled' | 'completed'

export type ConductorState =
  | {
      readonly status: 'starting'
      readonly generation: number
      readonly queued: readonly PendingMessage[]
    }
  | {
      readonly status: 'live'
      readonly threadId: string
      readonly generation: number
    }
  | {
      readonly status: 'down'
      readonly generation: number
      readonly reason: ConductorEndReason
      readonly queued: readonly PendingMessage[]
    }

export function initialConductor(): ConductorState {
  return { status: 'starting', generation: 0, queued: [] }
}

export function liveConductorThreadId(conductor: ConductorState): string | null {
  return conductor.status === 'live' ? conductor.threadId : null
}

export function shouldSpawnConductor(conductor: ConductorState): boolean {
  switch (conductor.status) {
    case 'starting':
      return true
    case 'down':
      return conductor.queued.length > 0
    case 'live':
      return false

    default: {
      const exhaustive: never = conductor

      return exhaustive
    }
  }
}

export function conductorChildThreadId(sessionThreadId: string, generation: number): string {
  return generation === 0
    ? deterministicThreadId(sessionThreadId, 'conductor')
    : deterministicThreadId(sessionThreadId, 'conductor', String(generation))
}

export function markConductorLive(conductor: ConductorState, threadId: string): ConductorState {
  return {
    status: 'live',
    threadId,
    generation: conductor.generation,
  }
}

/** Idempotent: only transitions away from `live` when `threadId` is the current conductor. */
export function markConductorDown(
  conductor: ConductorState,
  threadId: string,
  reason: ConductorEndReason,
): ConductorState {
  if (conductor.status !== 'live' || conductor.threadId !== threadId) {
    return conductor
  }

  return {
    status: 'down',
    generation: conductor.generation + 1,
    reason,
    queued: [],
  }
}

export function queueForConductor(
  conductor: ConductorState,
  message: PendingMessage,
): ConductorState {
  switch (conductor.status) {
    case 'starting':
    case 'down':
      return {
        ...conductor,
        queued: [...conductor.queued, message],
      }
    case 'live':
      return conductor

    default: {
      const exhaustive: never = conductor

      return exhaustive
    }
  }
}

export function conductorEndReason(eventType: string | undefined): ConductorEndReason {
  switch (eventType) {
    case 'runtime.thread.failed':
      return 'failed'
    case 'runtime.thread.cancelled':
      return 'cancelled'
    case 'runtime.thread.completed':
      return 'completed'
    default:
      return 'failed'
  }
}

export interface ConductorPromptInput {
  readonly runId: string
  readonly goal: string
  readonly briefText: string
  readonly briefVersion: number
  readonly repoUrl: string | null
  readonly repos: readonly LinkedSessionRepo[]
  readonly lessons: readonly { id: string; text: string; scope?: string }[]
  readonly playbookVersion: number
  readonly conductor: ConductorState
}

export function buildConductorInput(input: ConductorPromptInput): string {
  const { conductor } = input
  const queued = conductor.status === 'live' ? [] : conductor.queued

  const lessonBlock =
    input.lessons.length > 0
      ? `\n\nPlaybook v${input.playbookVersion}:\n${input.lessons.map((lesson) => `- ${lesson.text}`).join('\n')}`
      : ''

  const repoBlock =
    input.repos.length > 0
      ? `\n\nLinked repositories (edit only these session worktrees; Shuttle publishes PRs from them):\n${input.repos
          .map((repo) => `- ${repo.fullName}: ${worktreeRepoPath(input.runId, repo.name)}`)
          .join('\n')}`
      : `\n\nRepo: ${input.repoUrl ?? 'local demo workspace'}\nNo repositories are linked, so this session cannot open pull requests.`

  const restartBlock =
    conductor.status === 'down'
      ? `\n\nPrevious conductor ended (${conductor.reason}). Continue from the current brief.`
      : conductor.generation > 0
        ? `\n\nPrevious conductor ended. Continue from the current brief.`
        : ''

  const briefBlock =
    input.briefText !== input.goal
      ? `\n\nCurrent brief v${input.briefVersion}:\n${input.briefText}`
      : ''

  const queuedBlock =
    queued.length > 0
      ? `\n\nQueued user messages:\n${queued.map((message) => `- ${message.text}`).join('\n')}`
      : ''

  return `${input.goal}${lessonBlock}${repoBlock}${briefBlock}${restartBlock}${queuedBlock}`
}

export type ConductorSpawnReason = 'initial' | ConductorEndReason

export function spawnReason(conductor: ConductorState): ConductorSpawnReason {
  switch (conductor.status) {
    case 'starting':
      return 'initial'
    case 'down':
      return conductor.reason
    case 'live':
      return 'initial'

    default: {
      const exhaustive: never = conductor

      return exhaustive
    }
  }
}
