import { describe, expect, test } from 'bun:test'

import { workAgentsForRead, workInitialState } from '../session/work-projection'

describe('session_status read helpers', () => {
  test('adds long-running tool elapsed at read time', () => {
    const startedAt = 1_000
    const now = startedAt + 120_000

    const agents = workAgentsForRead(
      {
        ...workInitialState,
        entries: [
          {
            threadId: 'thr_worker',
            label: 'worker 1',
            role: 'worker',
            status: {
              kind: 'tool',
              name: 'bash',
              shortArgs: 'sleep 999',
              startedAt,
            },
            turnCount: 1,
            turnsSinceWrite: 0,
            recentToolCalls: [],
            recentArgSummaries: ['sleep 999'],
            filesWritten: [],
            filesEdited: [],
            stuckSignals: [],
            waitingChildren: [],
          },
        ],
      },
      now,
    )

    expect(agents[0]?.toolElapsedMs).toBe(120_000)
    expect(agents[0]?.stuckSignals).toContain('long_running_tool:bash')
  })
})
