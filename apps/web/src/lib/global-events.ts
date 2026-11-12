import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import type { SessionEvent } from '@/lib/event-catalog'

import { isRecord } from './json'

export type GlobalRunKind = 'session' | 'workspace' | 'playbook' | 'pulls'

export interface GlobalEventFrame {
  readonly cursor: number
  readonly runId: string
  readonly runKind: GlobalRunKind
  readonly event: SessionEvent
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

function isGlobalEventFrame(value: unknown): value is GlobalEventFrame {
  if (!isRecord(value)) {
    return false
  }

  const record = value
  return (
    typeof record.cursor === 'number' &&
    typeof record.runId === 'string' &&
    typeof record.runKind === 'string' &&
    record.event !== null &&
    typeof record.event === 'object'
  )
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

export function useGlobalEvents(filter: GlobalEventsFilter = {}) {
  const [state, dispatch] = useReducer(reduceGlobalEvents, INITIAL_STATE)
  const stateRef = useRef(state)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectAttempt = useRef(0)
  const disposedRef = useRef(false)

  const runKindsKey = (filter.runKinds ?? []).join(',')
  const runIdsKey = (filter.runIds ?? []).join(',')

  const socketFilter = useMemo(
    (): GlobalEventsFilter => ({
      ...(runKindsKey ? { runKinds: runKindsKey.split(',') as GlobalRunKind[] } : {}),
      ...(runIdsKey ? { runIds: runIdsKey.split(',') } : {}),
    }),
    [runKindsKey, runIdsKey],
  )

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    disposedRef.current = false
    dispatch({ type: 'reset' })

    let timer: ReturnType<typeof setTimeout> | undefined

    function connect() {
      if (disposedRef.current) {
        return
      }

      const after = stateRef.current.cursor

      dispatch({
        type: 'status',
        status: after > 0 ? 'reconnecting' : 'connecting',
      })

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

        if (isGlobalEventFrame(payload)) {
          dispatch({ type: 'append', frames: [payload] })
          return
        }

        if (isRecord(payload) && payload.type === 'error' && 'error' in payload) {
          dispatch({
            type: 'status',
            status: 'error',
            error: String(payload.error),
          })
        }
      })

      socket.addEventListener('close', () => {
        if (disposedRef.current) {
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
      disposedRef.current = true

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

    const body = (await response.json()) as { events?: unknown }
    const frames = Array.isArray(body.events) ? body.events.filter(isGlobalEventFrame) : []

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
