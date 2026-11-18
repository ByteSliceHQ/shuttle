import { describe, expect, test } from 'bun:test'

import { workAgentsForRead, workInitialState } from '../session/work-projection'
import { readRecentEvents } from './history'

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

describe('readRecentEvents', () => {
  const log = Array.from({ length: 1_200 }, (_, index) => ({
    runId: 'run',
    seq: index + 1,
    ts: index,
    // Mostly deltas, as a working session's log is.
    type:
      index + 1 === 40 || index + 1 === 1_150 ? 'shuttle.pr.published' : 'agent.turn.text_delta',
  }))

  const readPage = async (fromSeq: number, limit: number) =>
    log.filter((event) => event.seq >= fromSeq && event.seq < fromSeq + limit)

  test('finds the newest matching events however far back they are', async () => {
    const read = await readRecentEvents({
      tail: log.length,
      limit: 5,
      keep: (event) => event.type.startsWith('shuttle.pr.'),
      readPage,
    })

    expect(read?.events.map((event) => event.seq)).toEqual([1_150, 40])
    expect(read?.complete).toBe(true)
  })

  test('stops once it has enough', async () => {
    let pages = 0

    const read = await readRecentEvents({
      tail: log.length,
      limit: 3,
      keep: () => true,
      readPage: (fromSeq, limit) => {
        pages += 1
        return readPage(fromSeq, limit)
      },
    })

    expect(read?.events.map((event) => event.seq)).toEqual([1_200, 1_199, 1_198])
    expect(pages).toBe(1)
  })

  test('says so when the log cannot be read', async () => {
    expect(
      await readRecentEvents({ tail: 10, limit: 3, keep: () => true, readPage: async () => null }),
    ).toBeNull()
  })
})
