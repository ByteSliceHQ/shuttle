import { queryOptions } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { z } from 'zod'

import { isRecord } from '@/lib/json'

import type { SessionEvent } from './event-catalog'

/**
 * The firehose is Looms' own stream endpoint, not a route on the Worker's contract, so what it
 * sends is checked here: each frame over the socket, and each page of older ones.
 */
const GlobalRunKind = z.enum(['session', 'workspace', 'playbook', 'pulls'])

export type GlobalRunKind = z.infer<typeof GlobalRunKind>

const GlobalEventFrame = z.object({
  cursor: z.number(),
  runId: z.string(),
  runKind: GlobalRunKind,
  // The event is Looms' envelope, whatever kind it is. Views read its fields defensively.
  event: z.custom<SessionEvent>(isRecord),
})

export type GlobalEventFrame = Readonly<z.infer<typeof GlobalEventFrame>>

/** What the socket sends in place of a frame when it cannot go on. */
const SocketError = z.object({ type: z.literal('error'), error: z.unknown() })

const OlderPage = z.object({ events: z.array(z.unknown()).optional() })

/**
 * The frames in one page of older events. A frame that cannot be read is left out, as one over
 * the socket would be, so one bad event does not hide the rest of the page.
 */
export function framesOfPage(body: unknown): GlobalEventFrame[] {
  const page = OlderPage.safeParse(body)

  return (page.data?.events ?? []).flatMap((item) => {
    const frame = GlobalEventFrame.safeParse(item)

    return frame.success ? [frame.data] : []
  })
}

export interface GlobalEventsFilter {
  readonly runKinds?: readonly GlobalRunKind[]
  readonly runIds?: readonly string[]
}

export type GlobalEventsStatus = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'error'

export interface GlobalEventsState {
  readonly frames: readonly GlobalEventFrame[]
  readonly pending: readonly GlobalEventFrame[]
  readonly cursor: number
  readonly oldestCursor: number | null
  readonly paused: boolean
  readonly status: GlobalEventsStatus
  readonly error: string | null
  readonly hasMoreOlder: boolean
}

export const CLIENT_BUFFER_CAP = 5_000
export const OLDER_PAGE_SIZE = 100

const INITIAL_STATE: GlobalEventsState = {
  frames: [],
  pending: [],
  cursor: 0,
  oldestCursor: null,
  paused: false,
  status: 'connecting',
  error: null,
  hasMoreOlder: true,
}

type GlobalEventsAction =
  | { readonly type: 'reset' }
  | { readonly type: 'status'; readonly status: GlobalEventsStatus; readonly error?: string | null }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'append'; readonly frames: readonly GlobalEventFrame[] }
  | {
      readonly type: 'prepend'
      readonly frames: readonly GlobalEventFrame[]
      readonly exhausted: boolean
    }

function capFrames(frames: readonly GlobalEventFrame[]): readonly GlobalEventFrame[] {
  if (frames.length <= CLIENT_BUFFER_CAP) {
    return frames
  }

  return frames.slice(frames.length - CLIENT_BUFFER_CAP)
}

function mergeUniqueByCursor(
  existing: readonly GlobalEventFrame[],
  incoming: readonly GlobalEventFrame[],
): GlobalEventFrame[] {
  if (incoming.length === 0) {
    return [...existing]
  }

  const seen = new Set(existing.map((frame) => frame.cursor))
  const next = [...existing]

  for (const frame of incoming) {
    if (seen.has(frame.cursor)) {
      continue
    }

    seen.add(frame.cursor)
    next.push(frame)
  }

  next.sort((left, right) => left.cursor - right.cursor)
  return next
}

export function reduceGlobalEvents(
  state: GlobalEventsState,
  action: GlobalEventsAction,
): GlobalEventsState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_STATE }

    case 'status':
      return {
        ...state,
        status: state.paused && action.status === 'live' ? 'paused' : action.status,
        error: action.error ?? null,
      }

    case 'pause':
      return {
        ...state,
        paused: true,
        status: 'paused',
      }

    case 'resume': {
      const frames = capFrames(mergeUniqueByCursor(state.frames, state.pending))
      const cursor = frames.at(-1)?.cursor ?? state.cursor

      return {
        ...state,
        paused: false,
        pending: [],
        frames,
        cursor,
        oldestCursor: frames[0]?.cursor ?? state.oldestCursor,
        status: 'live',
      }
    }

    case 'append': {
      if (action.frames.length === 0) {
        return state
      }

      if (state.paused) {
        const pending = mergeUniqueByCursor(state.pending, action.frames)
        const cursor = pending.at(-1)?.cursor ?? state.cursor
        return { ...state, pending, cursor }
      }

      const frames = capFrames(mergeUniqueByCursor(state.frames, action.frames))

      return {
        ...state,
        frames,
        cursor: frames.at(-1)?.cursor ?? state.cursor,
        oldestCursor: frames[0]?.cursor ?? state.oldestCursor,
        status:
          state.status === 'connecting' || state.status === 'reconnecting' ? 'live' : state.status,
      }
    }

    case 'prepend': {
      if (action.frames.length === 0) {
        return {
          ...state,
          hasMoreOlder: action.exhausted ? false : state.hasMoreOlder,
        }
      }

      const frames = capFrames(mergeUniqueByCursor(action.frames, state.frames))

      return {
        ...state,
        frames,
        oldestCursor: frames[0]?.cursor ?? state.oldestCursor,
        cursor: frames.at(-1)?.cursor ?? state.cursor,
        hasMoreOlder: action.exhausted ? false : state.hasMoreOlder,
      }
    }

    default: {
      const exhaustive: never = action
      return exhaustive
    }
  }
}

function buildSocketUrl(filter: GlobalEventsFilter, after: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL(`${protocol}//${window.location.host}/firehose/socket`)

  if (after > 0) {
    url.searchParams.set('after', String(after))
  }

  if (filter.runKinds && filter.runKinds.length > 0) {
    url.searchParams.set('runKind', filter.runKinds.join(','))
  }

  if (filter.runIds && filter.runIds.length > 0) {
    url.searchParams.set('runId', filter.runIds.join(','))
  }

  return url.toString()
}

function buildPageUrl(filter: GlobalEventsFilter, before: number, limit: number): string {
  const url = new URL('/firehose/events', window.location.origin)
  url.searchParams.set('before', String(before))
  url.searchParams.set('limit', String(limit))

  if (filter.runKinds && filter.runKinds.length > 0) {
    url.searchParams.set('runKind', filter.runKinds.join(','))
  }

  if (filter.runIds && filter.runIds.length > 0) {
    url.searchParams.set('runId', filter.runIds.join(','))
  }

  return url.toString()
}

/** The filter the events page opens with: every kind of run, in every session. */
export const DEFAULT_EVENTS_FILTER: GlobalEventsFilter = {
  runKinds: [...GlobalRunKind.options],
}

/**
 * The most recent events, read over HTTP. The events page's loader waits for this, so the page
 * opens on a full log instead of an empty one that says it is connecting. The socket then picks
 * up from where this left off.
 */
export const latestEventsQuery = queryOptions({
  queryKey: ['firehose', 'latest'] as const,
  queryFn: async ({ signal }): Promise<GlobalEventFrame[]> => {
    const response = await fetch(
      buildPageUrl(DEFAULT_EVENTS_FILTER, Number.MAX_SAFE_INTEGER, OLDER_PAGE_SIZE),
      { signal },
    )

    if (!response.ok) {
      throw new Error(`Could not load events (${response.status}).`)
    }

    return framesOfPage(await response.json())
  },
  // A log is only worth opening on if it is current.
  staleTime: 5000,
  gcTime: 30_000,
})

/** Where the log starts when it already has events: showing them, and counted as live. */
export function seededState(frames: readonly GlobalEventFrame[]): GlobalEventsState {
  if (frames.length === 0) {
    return INITIAL_STATE
  }

  return {
    ...INITIAL_STATE,
    frames: [...frames],
    cursor: frames.at(-1)?.cursor ?? 0,
    oldestCursor: frames[0]?.cursor ?? null,
    status: 'live',
    hasMoreOlder: frames.length >= OLDER_PAGE_SIZE,
  }
}

/**
 * Follows the organization's events. `seed` is what the page already has for `filter` when it
 * first renders; the socket continues from its last event.
 */
export function useGlobalEvents(
  filter: GlobalEventsFilter = {},
  seed: readonly GlobalEventFrame[] = [],
) {
  const [state, dispatch] = useReducer(reduceGlobalEvents, seed, seededState)
  const stateRef = useRef(state)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectAttempt = useRef(0)

  const runKindsKey = (filter.runKinds ?? []).join(',')
  const runIdsKey = (filter.runIds ?? []).join(',')

  const socketFilter = useMemo(
    (): GlobalEventsFilter => ({
      ...(runKindsKey ? { runKinds: z.array(GlobalRunKind).parse(runKindsKey.split(',')) } : {}),
      ...(runIdsKey ? { runIds: runIdsKey.split(',') } : {}),
    }),
    [runKindsKey, runIdsKey],
  )

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // The filter the events on screen were read with. A different one means a different log.
  const shownFilter = useRef(socketFilter)

  useEffect(() => {
    // Each run of this effect has its own sockets. One flag shared between runs would let a
    // socket closed by an earlier run reconnect as if it belonged to this one.
    let disposed = false

    if (shownFilter.current !== socketFilter) {
      shownFilter.current = socketFilter
      stateRef.current = INITIAL_STATE
      dispatch({ type: 'reset' })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true

    function connect() {
      if (disposed) {
        return
      }

      const after = stateRef.current.cursor

      // A log that opened with events already on it is not "reconnecting" the first time.
      if (!(first && after > 0)) {
        dispatch({
          type: 'status',
          status: after > 0 ? 'reconnecting' : 'connecting',
        })
      }

      first = false

      const socket = new WebSocket(buildSocketUrl(socketFilter, after))
      socketRef.current = socket

      socket.addEventListener('open', () => {
        reconnectAttempt.current = 0
        dispatch({ type: 'status', status: 'live' })
      })

      socket.addEventListener('message', (message) => {
        let payload: unknown

        try {
          payload = JSON.parse(String(message.data))
        } catch {
          return
        }

        const frame = GlobalEventFrame.safeParse(payload)

        if (frame.success) {
          dispatch({ type: 'append', frames: [frame.data] })
          return
        }

        const failure = SocketError.safeParse(payload)

        if (failure.success) {
          dispatch({
            type: 'status',
            status: 'error',
            error: String(failure.data.error),
          })
        }
      })

      socket.addEventListener('close', () => {
        if (disposed) {
          return
        }

        socketRef.current = null
        const attempt = reconnectAttempt.current++
        const delay = Math.min(10_000, 500 * 2 ** attempt)
        dispatch({ type: 'status', status: 'reconnecting' })
        timer = setTimeout(connect, delay)
      })

      socket.addEventListener('error', () => {
        socket.close()
      })
    }

    connect()

    return () => {
      disposed = true

      if (timer) {
        clearTimeout(timer)
      }

      socketRef.current?.close()
      socketRef.current = null
    }
  }, [socketFilter])

  const pause = useCallback(() => {
    dispatch({ type: 'pause' })
  }, [])

  const resume = useCallback(() => {
    dispatch({ type: 'resume' })
  }, [])

  const loadOlder = useCallback(async () => {
    const current = stateRef.current
    const before = current.oldestCursor

    if (before === null || before <= 1 || !current.hasMoreOlder) {
      return
    }

    const response = await fetch(buildPageUrl(socketFilter, before, OLDER_PAGE_SIZE))

    if (!response.ok) {
      dispatch({
        type: 'status',
        status: 'error',
        error: `Failed to load older events: ${response.status}`,
      })

      return
    }

    const body: unknown = await response.json()
    const frames = framesOfPage(body)

    dispatch({
      type: 'prepend',
      frames,
      exhausted: frames.length < OLDER_PAGE_SIZE,
    })
  }, [socketFilter])

  return {
    ...state,
    visible: state.paused ? state.frames : state.frames,
    pendingCount: state.pending.length,
    pause,
    resume,
    loadOlder,
  }
}
