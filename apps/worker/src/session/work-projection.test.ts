import { describe, expect, test } from 'bun:test'

import type { EventEnvelope } from '@swirls/looms/core'

import {
  work,
  workAgentsForRead,
  workInitialState,
  type WorkProjectionState,
} from './work-projection'

function evt(
  partial: Pick<EventEnvelope, 'type' | 'payload' | 'threadId'> &
    Partial<Pick<EventEnvelope, 'seq' | 'ts' | 'id'>>,
): EventEnvelope {
  return {
    id: partial.id ?? `ev_${partial.seq ?? 0}`,
    runId: 'run_session',
    seq: partial.seq ?? 0,
    ts: partial.ts ?? partial.seq ?? 0,
    type: partial.type,
    payload: partial.payload,
    threadId: partial.threadId ?? null,
    origin: { type: 'external' },
  }
}

function fold(events: readonly EventEnvelope[]): WorkProjectionState {
  return events.reduce((state, event) => work.reduce(state, event), workInitialState)
}

describe('work projection', () => {
  test('tracks worker task, long-running tool signal at read time, and turns without write', () => {
    const baseTs = 1_000_000

    const state = fold([
      evt({
        type: 'runtime.thread.started',
        seq: 1,
        ts: baseTs,
        threadId: 'thr_conductor',
        payload: {
          threadId: 'thr_conductor',
          kind: 'agent',
          definitionName: 'conductor',
          input: { text: 'Ship the feature' },
        },
      }),
      evt({
        type: 'agent.tool_call.requested',
        seq: 2,
        ts: baseTs + 10,
        threadId: 'thr_conductor',
        payload: {
          turn: 1,
          toolCall: {
            id: 'del_1',
            name: 'delegate',
            arguments: { text: 'Implement API handler' },
          },
        },
      }),
      evt({
        type: 'agent.spawn.requested',
        seq: 3,
        ts: baseTs + 11,
        threadId: 'thr_conductor',
        payload: { toolCallId: 'del_1', childThreadId: 'thr_worker_1' },
      }),
      evt({
        type: 'runtime.thread.started',
        seq: 4,
        ts: baseTs + 12,
        threadId: 'thr_worker_1',
        payload: {
          threadId: 'thr_worker_1',
          kind: 'agent',
          definitionName: 'worker',
          input: { text: 'Implement API handler' },
        },
      }),
      evt({
        type: 'agent.tool_call.requested',
        seq: 5,
        ts: baseTs + 20,
        threadId: 'thr_worker_1',
        payload: {
          turn: 1,
          toolCall: { id: 'bash_1', name: 'bash', arguments: { command: 'npm test' } },
        },
      }),
      evt({
        type: 'agent.turn.settled',
        seq: 6,
        ts: baseTs + 30,
        threadId: 'thr_worker_1',
        payload: { turn: 1 },
      }),
      evt({
        type: 'agent.turn.settled',
        seq: 7,
        ts: baseTs + 40,
        threadId: 'thr_worker_1',
        payload: { turn: 2 },
      }),
      evt({
        type: 'agent.turn.settled',
        seq: 8,
        ts: baseTs + 50,
        threadId: 'thr_worker_1',
        payload: { turn: 3 },
      }),
      evt({
        type: 'agent.turn.settled',
        seq: 9,
        ts: baseTs + 60,
        threadId: 'thr_worker_1',
        payload: { turn: 4 },
      }),
      evt({
        type: 'agent.turn.settled',
        seq: 10,
        ts: baseTs + 70,
        threadId: 'thr_worker_1',
        payload: { turn: 5 },
      }),
    ])

    const worker = state.entries.find((entry) => entry.threadId === 'thr_worker_1')

    expect(worker?.label).toBe('worker 1')
    expect(worker?.task).toContain('API handler')
    expect(worker?.status.kind).toBe('tool')
    expect(worker?.turnsSinceWrite).toBeGreaterThanOrEqual(5)

    expect(worker?.stuckSignals.some((signal) => signal.startsWith('turns_without_write:'))).toBe(
      true,
    )

    const readAt = baseTs + 20 + 90_000
    const agents = workAgentsForRead(state, readAt)
    const workerSnap = agents.find((entry) => entry.threadId === 'thr_worker_1')

    expect(workerSnap?.toolElapsedMs).toBeGreaterThanOrEqual(60_000)

    expect(workerSnap?.stuckSignals.some((signal) => signal.startsWith('long_running_tool:'))).toBe(
      true,
    )
  })

  test('records write_file paths and repeated tool errors', () => {
    const state = fold([
      evt({
        type: 'runtime.thread.started',
        seq: 1,
        threadId: 'thr_worker_1',
        payload: {
          threadId: 'thr_worker_1',
          kind: 'agent',
          definitionName: 'worker',
          input: { text: 'Edit readme' },
        },
      }),
      evt({
        type: 'agent.tool_call.requested',
        seq: 2,
        ts: 100,
        threadId: 'thr_worker_1',
        payload: {
          turn: 1,
          toolCall: {
            id: 'w1',
            name: 'write_file',
            arguments: { path: 'README.md', content: 'x' },
          },
        },
      }),
      evt({
        type: 'agent.tool.result',
        seq: 3,
        ts: 200,
        threadId: 'thr_worker_1',
        payload: {
          toolCallId: 'w1',
          name: 'write_file',
          result: { path: 'README.md', ok: true },
          error: null,
        },
      }),
    ])

    const worker = state.entries.find((entry) => entry.threadId === 'thr_worker_1')

    expect(worker?.filesWritten).toEqual(['README.md'])
    expect(worker?.turnsSinceWrite).toBe(0)
  })
})
