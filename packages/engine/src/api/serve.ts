import { Effect } from 'effect'

import { issueRunGrant, runGrantToken } from '@swirls/looms/runtime'

import { resolveHost, type ResolvedHost, type ShuttleHost } from '../ports/host'
import { actorOfActing } from '../ports/identity'
import type { Actor } from '../tenancy/access'
import { handleAssetRoutes } from './assets'
import type { ApiContext } from './base'
import { handleFirehoseRoutes } from './firehose'
import { authorizeRun, runIdOfPath } from './gate'
import { handleApi } from './handler'
import { handleSandboxRoutes } from './terminal'

/**
 * One part of Shuttle's HTTP API, which a host serves or leaves out. A request is offered to the
 * modules a host mounted, in order, once it is known who is asking and that they may open the
 * run the path names.
 */
export interface ApiModule {
  /** What the module is called in `GET /capabilities`, where a page reads what it may show. */
  readonly name: string
  /** Whether a path is this module's to answer. A path no module claims is not Shuttle's. */
  claims(pathname: string): boolean
  handle(context: ApiContext, host: ResolvedHost): Promise<Response | null>
  /**
   * Answers a request that carries a run's read grant in place of a sign-in. Only a module that
   * serves a run's log has one. `secret` is what the host signs grants with.
   */
  handleGranted?(request: Request, host: ResolvedHost, secret: string): Promise<Response | null>
}

const under = (...roots: readonly string[]) => {
  const pattern = new RegExp(`^/(?:${roots.join('|')})(?:/|$)`)

  return (pathname: string) => pattern.test(pathname)
}

/** A session, its playbook and its sandbox's files: the routes of the API contract. */
export const sessionApi: ApiModule = {
  name: 'session',
  claims: under('sessions', 'playbook'),
  handle: (context) => handleApi(context),
}

/** A session's attachments and the media its agents make. Needs the `ASSETS` bucket. */
export const assetsApi: ApiModule = {
  name: 'assets',
  claims: (pathname) => /^\/sessions\/[^/]+\/assets(?:\/|$)/.test(pathname),
  handle: ({ request, env, actor }) => handleAssetRoutes(request, env, actor),
}

/** A session's terminal, a WebSocket into its sandbox. */
export const terminalApi: ApiModule = {
  name: 'terminal',
  claims: (pathname) => /^\/sessions\/[^/]+\/sandbox\/terminal$/.test(pathname),
  handle: ({ request, env, actor }) => handleSandboxRoutes(request, env, actor),
}

/** The organization's stream of everything its public sessions do. */
export const firehoseApi: ApiModule = {
  name: 'firehose',
  claims: under('firehose'),
  handle: ({ request, env, actor }) => handleFirehoseRoutes(request, env, actor),
}

/**
 * The modules that load anywhere. A run's own log, which every one of them shows, is `runsApi`
 * in `@shuttle/engine/worker`: it forwards to Durable Objects, so it loads only in a Worker.
 * `shuttleApiModules` there is all of them.
 */
export const portableApiModules: readonly ApiModule[] = [
  assetsApi,
  terminalApi,
  sessionApi,
  firehoseApi,
]

export interface ServeOptions {
  /** The modules to serve, in the order a request is offered to them. */
  readonly modules: readonly ApiModule[]
  /**
   * The origins of the pages that embed Shuttle, when they are not this Worker's own. Requests
   * from them are answered with the headers a browser needs to read the answer across origins.
   */
  readonly origins?: readonly string[]
  /**
   * Signs read grants for runs. A page on another origin cannot put a credential on a WebSocket,
   * so it asks `POST /runs/:id/grant` for a short-lived grant and opens the run's log with it.
   * At least 32 random characters. Without one, no grants are given or taken.
   */
  readonly grantSecret?: string
  /** How long a grant lasts, in milliseconds. Defaults to five minutes. */
  readonly grantTtlMs?: number
  /**
   * The path Shuttle is mounted under, such as `/shuttle`, when the host serves routes of its
   * own beside it. Only paths under it are answered, with it taken off before a module sees
   * them (`/shuttle/sessions/…` reaches the session module as `/sessions/…`). A path under it
   * that no module claims is answered 404, so a page on a listed origin can read that too.
   */
  readonly basePath?: string
}

const DEFAULT_GRANT_TTL_MS = 5 * 60_000

const ALLOWED_HEADERS =
  'authorization, content-type, x-shuttle-device, x-shuttle-org, x-shuttle-user'

function refused(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

/** The answer with what lets a page on `origin` read it. A WebSocket's answer is left as it is. */
function shared(response: Response, origin: string | null): Response {
  if (origin === null || response.status === 101) {
    return response
  }

  const headers = new Headers(response.headers)

  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.append('vary', 'origin')

  return new Response(response.body, { status: response.status, headers })
}

function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': ALLOWED_HEADERS,
      'access-control-max-age': '600',
      vary: 'origin',
    },
  })
}

/** `basePath` without a trailing slash, or null when Shuttle is mounted at the root. */
function normalizeBasePath(basePath: string | undefined): string | null {
  if (basePath === undefined) {
    return null
  }

  const trimmed = basePath.replace(/\/+$/, '')

  if (trimmed === '') {
    return null
  }

  if (!trimmed.startsWith('/') || /[?#]/.test(trimmed)) {
    throw new Error(`basePath must be a path such as '/shuttle', not '${basePath}'`)
  }

  return trimmed
}

/** The request with `basePath` taken off its path, or null for a path outside it. */
function withinBase(request: Request, basePath: string): Request | null {
  const url = new URL(request.url)

  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return null
  }

  const rest = url.pathname.slice(basePath.length)

  url.pathname = rest === '' ? '/' : rest

  return new Request(url, request)
}

/**
 * Makes the function that answers Shuttle's HTTP API for a host: the modules it mounts, behind
 * its own identity port and the check of who may open which run. It answers null for a path
 * that is not Shuttle's, so a host puts it in front of, or behind, routes of its own:
 *
 * ```ts
 * const shuttle = serveShuttle(host(env), { modules: shuttleApiModules })
 *
 * return (await shuttle(request, ctx)) ?? theHostsOwnRoutes(request)
 * ```
 *
 * With `basePath`, it answers everything under that path and null for the rest.
 */
export function serveShuttle(host: ShuttleHost, options: ServeOptions) {
  const resolved = resolveHost(host)
  const { env, ports } = resolved
  const { modules } = options
  const origins = options.origins ?? []
  const grantSecret = options.grantSecret
  const grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
  const basePath = normalizeBasePath(options.basePath)

  const answer = async (request: Request, ctx?: ExecutionContext): Promise<Response | null> => {
    const url = new URL(request.url)
    const claimed = modules.filter((module) => module.claims(url.pathname))

    if (claimed.length === 0 && url.pathname !== '/capabilities') {
      return null
    }

    if (url.pathname === '/capabilities') {
      return Response.json({
        modules: modules.map((module) => module.name),
        previews: ports.previews !== null,
        grants: grantSecret !== undefined,
      })
    }

    const acting = await ports.identity.resolve(request)

    if (acting === null) {
      // A grant stands in for a sign-in, for reading the one run it names.
      if (grantSecret !== undefined && runGrantToken(request) !== undefined) {
        for (const module of claimed) {
          const response = await module.handleGranted?.(request, resolved, grantSecret)

          if (response) {
            return response
          }
        }
      }

      return refused(401, 'Sign in to continue')
    }

    const actor: Actor = actorOfActing(acting)
    const runId = runIdOfPath(url.pathname)

    if (runId === null && /^\/(?:runs|sessions)\/./.test(url.pathname)) {
      return refused(404, 'Not found')
    }

    if (runId !== null) {
      const denied = await authorizeRun(env, actor, runId)

      if (denied) {
        return denied
      }

      if (
        grantSecret !== undefined &&
        request.method === 'POST' &&
        url.pathname === `/runs/${encodeURIComponent(runId)}/grant`
      ) {
        const exp = Date.now() + grantTtlMs

        const grant = await Effect.runPromise(
          issueRunGrant(grantSecret, { runId, principal: actor.userId, access: 'read', exp }),
        )

        return Response.json({ grant, expiresAt: exp })
      }
    }

    const context: ApiContext = {
      env,
      actor,
      request,
      ctx,
      ports,
      trustedOrigins: origins.length > 0 ? origins : undefined,
    }

    for (const module of claimed) {
      const response = await module.handle(context, resolved)

      if (response) {
        return response
      }
    }

    return refused(404, 'Not found')
  }

  return async (request: Request, ctx?: ExecutionContext): Promise<Response | null> => {
    const inner = basePath === null ? request : withinBase(request, basePath)

    if (inner === null) {
      return null
    }

    const origin = inner.headers.get('origin')
    const allowed = origin !== null && origins.includes(origin) ? origin : null

    if (allowed !== null && inner.method === 'OPTIONS') {
      return preflight(allowed)
    }

    const response =
      (await answer(inner, ctx)) ?? (basePath === null ? null : refused(404, 'Not found'))

    return response === null ? null : shared(response, allowed)
  }
}
