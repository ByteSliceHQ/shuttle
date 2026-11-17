import { describe, expect, test } from 'bun:test'

import type { SessionEvent } from './event-catalog'
import {
  CLIENT_BUFFER_CAP,
  framesOfPage,
  OLDER_PAGE_SIZE,
  reduceGlobalEvents,
  seededState,
  type GlobalEventFrame,
  type GlobalEventsState,
} from './global-events'

function frame(cursor: number, runId = 'session_a', type = 'agent.message'): GlobalEventFrame {
  const event = {
    id: `evt_${cursor}`,
    runId,
    seq: cursor,
    ts: 1_700_000_000_000 + cursor,
    type,
    payload: {},
    threadId: 'thr_1',
    origin: { type: 'system' },
  } as SessionEvent

  return {
    cursor,
    runId,
    runKind: 'session',
    event,
  }
}

function state(partial: Partial<GlobalEventsState> = {}): GlobalEventsState {
  return {
    frames: [],
    pending: [],
    cursor: 0,
    oldestCursor: null,
    paused: false,
    status: 'connecting',
    error: null,
    hasMoreOlder: true,
    ...partial,
  }
}

describe('reduceGlobalEvents', () => {
  test('appends frames, advances cursor, and dedupes by cursor', () => {
    let next = reduceGlobalEvents(state(), {
      type: 'append',
      frames: [frame(1), frame(2)],
    })

    expect(next.frames.map((item) => item.cursor)).toEqual([1, 2])
    expect(next.cursor).toBe(2)
    expect(next.oldestCursor).toBe(1)
    expect(next.status).toBe('live')

    next = reduceGlobalEvents(next, {
      type: 'append',
      frames: [frame(2), frame(3)],
    })

    expect(next.frames.map((item) => item.cursor)).toEqual([1, 2, 3])
    expect(next.cursor).toBe(3)
  })

  test('queues appends while paused and flushes on resume', () => {
    let next = reduceGlobalEvents(state({ frames: [frame(1)], cursor: 1, oldestCursor: 1 }), {
      type: 'pause',
    })

    expect(next.paused).toBe(true)
    expect(next.status).toBe('paused')

    next = reduceGlobalEvents(next, {
      type: 'append',
      frames: [frame(2), frame(3)],
    })

    expect(next.frames.map((item) => item.cursor)).toEqual([1])
    expect(next.pending.map((item) => item.cursor)).toEqual([2, 3])
    expect(next.cursor).toBe(3)

    next = reduceGlobalEvents(next, { type: 'resume' })
    expect(next.paused).toBe(false)
    expect(next.pending).toEqual([])
    expect(next.frames.map((item) => item.cursor)).toEqual([1, 2, 3])
    expect(next.status).toBe('live')
  })

  test('caps the client buffer to the newest frames', () => {
    const frames = Array.from({ length: CLIENT_BUFFER_CAP + 25 }, (_, index) => frame(index + 1))

    const next = reduceGlobalEvents(state(), {
      type: 'append',
      frames,
    })

    expect(next.frames).toHaveLength(CLIENT_BUFFER_CAP)
    expect(next.frames[0]?.cursor).toBe(26)
    expect(next.frames.at(-1)?.cursor).toBe(CLIENT_BUFFER_CAP + 25)
  })

  test('prepends older pages and marks exhaustion', () => {
    let next = reduceGlobalEvents(
      state({ frames: [frame(10), frame(11)], cursor: 11, oldestCursor: 10 }),
      {
        type: 'prepend',
        frames: [frame(8), frame(9)],
        exhausted: false,
      },
    )

    expect(next.frames.map((item) => item.cursor)).toEqual([8, 9, 10, 11])
    expect(next.oldestCursor).toBe(8)
    expect(next.hasMoreOlder).toBe(true)

    next = reduceGlobalEvents(next, {
      type: 'prepend',
      frames: [],
      exhausted: true,
    })

    expect(next.hasMoreOlder).toBe(false)
  })

  test('reset clears buffer state', () => {
    const next = reduceGlobalEvents(
      state({
        frames: [frame(1)],
        pending: [frame(2)],
        cursor: 2,
        paused: true,
        status: 'paused',
      }),
      { type: 'reset' },
    )

    expect(next.frames).toEqual([])
    expect(next.pending).toEqual([])
    expect(next.cursor).toBe(0)
    expect(next.paused).toBe(false)
    expect(next.status).toBe('connecting')
  })
})

describe('framesOfPage', () => {
  test('reads the frames of a page', () => {
    expect(framesOfPage({ events: [frame(1), frame(2)] }).map((item) => item.cursor)).toEqual([
      1, 2,
    ])
  })

  test('leaves out what is not a frame and keeps the rest', () => {
    const page = {
      events: [
        frame(1),
        null,
        { cursor: '2', runId: 'session_a', runKind: 'session', event: {} },
        { ...frame(3), runKind: 'something-else' },
        { ...frame(4), event: 'not an event' },
        frame(5),
      ],
    }

    expect(framesOfPage(page).map((item) => item.cursor)).toEqual([1, 5])
  })

  test('finds nothing in an answer that is not a page', () => {
    expect(framesOfPage(null)).toEqual([])
    expect(framesOfPage({})).toEqual([])
    expect(framesOfPage({ events: 'none' })).toEqual([])
  })
})

describe('seededState', () => {
  test('opens on the events it was given, live, with the socket to continue after the last', () => {
    const seeded = seededState([frame(4), frame(5), frame(9)])

    expect(seeded.frames.map((item) => item.cursor)).toEqual([4, 5, 9])
    expect(seeded.cursor).toBe(9)
    expect(seeded.oldestCursor).toBe(4)
    expect(seeded.status).toBe('live')
    // Fewer than a page came back, so there is nothing older to ask for.
    expect(seeded.hasMoreOlder).toBe(false)
  })

  test('a full page leaves older events to load', () => {
    const page = Array.from({ length: OLDER_PAGE_SIZE }, (_, index) => frame(index + 1))

    expect(seededState(page).hasMoreOlder).toBe(true)
  })

  test('with nothing to open on, it connects as an empty log does', () => {
    const seeded = seededState([])

    expect(seeded.frames).toEqual([])
    expect(seeded.status).toBe('connecting')
    expect(seeded.cursor).toBe(0)
  })
})
