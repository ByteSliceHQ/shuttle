import { createORPCClient, ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

import { clientContract } from '@shuttle/api'
import { preloadRunStore, type RunStoreOptions } from '@swirls/looms/react'

import { eventCacheFor } from '../features/events/event-cache'
import type { ShuttleDevice } from './device'

/** What a single call may add to its request. */
export interface CallContext {
  /**
   * This machine's id, sent when a call is about the sandbox on this machine as well as the
   * cloud. Only a host with a device has one.
   */
  readonly deviceId?: string | null
}

/**
 * The backend's API, typed from the contract in `@shuttle/api`. Call it directly for one-off
 * requests: `await client.sessions.rename({ id, title })`.
 *
 * Everything on the contract is plain JSON (no dates, files or bigints), so what arrives is
 * exactly what the schemas say and the types need no JSON conversion applied.
 */
export type ShuttleClient = ContractRouterClient<typeof clientContract, CallContext>

function queryUtils(client: ShuttleClient) {
  return createTanstackQueryUtils(client)
}

/**
 * The same API as TanStack Query options:
 * `api.sessions.team.get.queryOptions({ input: { id } })`, `api.sessions.rename.mutationOptions()`.
 */
export type ShuttleApi = ReturnType<typeof queryUtils>

/** `fetch`, as far as Shuttle uses it. */
export type ShuttleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ShuttleHostOptions {
  /**
   * Where the Shuttle backend is, such as `https://build.example.com`. Left out, it is the
   * page's own origin.
   */
  readonly baseUrl?: string
  /** Makes every HTTP request, so a host can add its own credentials. Defaults to `fetch`. */
  readonly fetch?: ShuttleFetch
  /** The machine this is running on, when it has one. */
  readonly device?: ShuttleDevice | null
  /**
   * The port sandbox previews are served on, when it is not the backend's own: a development
   * server that passes the API on to the backend does not pass on a preview's subdomain.
   */
  readonly previewPort?: string | number
  /**
   * Offers made-up workspaces in place of the real one, for looking at how the parts cope with
   * the empty, the huge and the worst case. For development.
   */
  readonly fixtures?: boolean
  /** Added to how a run's event store is opened: an observer, a different cache. */
  readonly runStore?: (userId: string) => Partial<RunStoreOptions>
}

/**
 * Everything Shuttle's components need from where they are running that is not React: how to
 * reach the backend, and the machine they are on. One is made per backend, outside React, so
 * that code which runs before a page renders (a route loader) uses the same client, the same
 * query keys and the same run stores as the components that render after it.
 */
export interface ShuttleHost {
  readonly client: ShuttleClient
  readonly api: ShuttleApi
  readonly device: ShuttleDevice | null
  readonly fetch: ShuttleFetch
  /** The port sandbox previews are served on, or null when it is the backend's own. */
  readonly previewPort: string | null
  /** Whether made-up workspaces are offered in place of the real one. */
  readonly fixtures: boolean
  /** The backend's origin, such as `https://app.example.com`. */
  origin(): string
  /** The address of `path` (which starts with `/`) on the backend. */
  url(path: string): string
  /** The same, for a WebSocket. */
  socketUrl(path: string): string
  /**
   * What a call sends so the backend answers for this machine's sandbox as well as the cloud.
   * With no device, the call is about the cloud alone.
   */
  deviceContext(): CallContext
  /**
   * Sends a named signal to a run. What the signal does is read back from the run's event
   * stream, not from the response.
   */
  signalRun(runId: string, name: string, input: object): Promise<void>
  /**
   * How a run's event store is opened for the person signed in. The provider and anything that
   * preloads are given the same object, so a store opened ahead of a page is the one it uses.
   */
  runStoreOptions(userId: string): RunStoreOptions
  /**
   * Resolves once the run's log has been read as far as it went when asked, so a page drawn
   * from it arrives whole. After a few seconds it goes ahead regardless. Never rejects.
   */
  whenRunSynced(runId: string, userId: string): Promise<void>
}

/** A run refused a signal. `status` is the HTTP status it answered with. */
export class SignalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The HTTP status a failed call came back with, when it reached the backend at all. */
export function statusOf(cause: unknown): number | undefined {
  return cause instanceof ORPCError ? cause.status : undefined
}

export function isSignedOut(cause: unknown): boolean {
  return statusOf(cause) === 401
}

/**
 * A session stays connected for a while after it is left, so going back to it shows it at once
 * instead of downloading its log again.
 */
const SESSION_RETAIN_MS = 5 * 60_000

/** How long a page waits on a run's log before going ahead without it. */
const WAIT_MS = 4000

export function createShuttleHost(options: ShuttleHostOptions = {}): ShuttleHost {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '')
  const device = options.device ?? null
  const request: ShuttleFetch = options.fetch ?? ((input, init) => fetch(input, init))

  /** The backend's origin: the one it was given, or the page's own. */
  const origin = () => baseUrl || window.location.origin

  const client: ShuttleClient = createORPCClient(
    new OpenAPILink<CallContext>(clientContract, {
      url: origin,
      fetch: (input, init) => request(input, init),
      headers: ({ context }) => (context.deviceId ? { 'x-shuttle-device': context.deviceId } : {}),
    }),
  )

  const runStores = new Map<string, RunStoreOptions>()

  function runStoreOptions(userId: string): RunStoreOptions {
    const existing = runStores.get(userId)

    if (existing) {
      return existing
    }

    const created: RunStoreOptions = {
      endpoint: baseUrl,
      // SSE holds one of the browser's six HTTP/1.1 connections per origin for each run store;
      // across a few tabs that starves route chunks and API calls. WebSockets have their own pool.
      transport: 'websocket',
      retainMs: SESSION_RETAIN_MS,
      cache: eventCacheFor(userId),
      ...options.runStore?.(userId),
    }

    runStores.set(userId, created)

    return created
  }

  return {
    client,
    api: queryUtils(client),
    device,
    fetch: request,
    previewPort: options.previewPort === undefined ? null : String(options.previewPort),
    fixtures: options.fixtures ?? false,
    origin,
    url: (path) => `${baseUrl}${path}`,
    socketUrl: (path) => `${origin().replace(/^http/, 'ws')}${path}`,
    deviceContext: () => ({ deviceId: device?.deviceId ?? null }),
    runStoreOptions,

    async signalRun(runId, name, input) {
      // Looms takes a signal's input wrapped as `{ input }`. `respond=async` has the run answer
      // once the signal is on its log, since the page follows what happens next on the stream.
      const response = await request(
        `${baseUrl}/runs/${encodeURIComponent(runId)}/signals/${name}?respond=async`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
        },
      )

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 300)

        throw new SignalError(
          detail || `The session refused the request (${response.status}).`,
          response.status,
        )
      }
    },

    async whenRunSynced(runId, userId) {
      await preloadRunStore(runId, {
        ...runStoreOptions(userId),
        signal: AbortSignal.timeout(WAIT_MS),
      }).catch(() => {})
    },
  }
}
