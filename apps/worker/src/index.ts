import { loomsStub } from '@shuttle/engine/looms-stub'
import { shuttleModules } from '@shuttle/engine/modules'
import type { ShuttleHost } from '@shuttle/engine/ports/host'
import { actorOfActing } from '@shuttle/engine/ports/identity'
import { EventFirehose, SessionSandbox, ShuttleRun } from '@shuttle/engine/worker'
import { sandboxNameFor } from '@shuttle/engine/workspace/thread'
import { httpsRedirect, withHsts } from '@shuttle/sandbox/https'
import { sandboxesArePersonal } from '@shuttle/sandbox/names'
import { isOwnHost, parsePreviewHost } from '@shuttle/sandbox/preview-host'
import { routeToDurableObject, type LoomsDurableObjectConfig } from '@swirls/looms/cloudflare'

import { handleApi } from './api/handler'
import { handlePublicApi } from './api/public'
import { AUTH_BASE_PATH, AuthUnavailableError, getAuth } from './auth/auth'
import { refuseSignUp } from './auth/signup-code'
import type { ShuttleEnv } from './env'
import { sandboxStub } from './env'
import { workerHost, workerIdentity } from './host'
import { handleAssetRoutes } from './routes/assets'
import { handleFirehoseRoutes } from './routes/firehose'
import { handleGithubPublicRoutes, handleGithubRoutes } from './routes/github'
import { handleRunnerTokenRoutes } from './routes/runners'
import { handleSandboxRoutes } from './routes/sandbox'
import { authorizeLoomsRoute, authorizeRun, runIdOfPath } from './tenancy/gate'
import { runOfPreviewKey } from './tenancy/previews'
import { runTimingObserver } from './timing'
import { isWebAppRequest } from './web-app'

export { EventFirehose, SessionSandbox }

/** Shuttle's own app as a host of the engine's run. */
export class LoomsRun extends ShuttleRun<ShuttleEnv> {
  protected override host(env: ShuttleEnv): ShuttleHost {
    return workerHost(env)
  }

  override configure(env: ShuttleEnv): LoomsDurableObjectConfig {
    return { ...super.configure(env), observer: runTimingObserver(this.ctx.id.name ?? '') }
  }
}

export default {
  async fetch(request: Request, env: ShuttleEnv, ctx: ExecutionContext): Promise<Response> {
    const secure = httpsRedirect(request)

    if (secure) {
      return secure
    }

    const preview = await handlePreviewHost(request, env)

    if (preview) {
      return preview
    }

    const url = new URL(request.url)

    if (!isOwnHost(url.hostname, env.SHUTTLE_WEB_URL)) {
      return new Response('Not Found', { status: 404 })
    }

    // A deployment serves the web app itself. In development Vite does, and `WEB` is absent.
    if (env.WEB && isWebAppRequest(request)) {
      return withHsts(request, await env.WEB.fetch(request))
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    try {
      return await route(request, env, ctx, url)
    } catch (cause) {
      if (cause instanceof AuthUnavailableError) {
        return Response.json({ error: cause.message }, { status: 503 })
      }

      throw cause
    }
  },
} satisfies ExportedHandler<ShuttleEnv>

async function route(
  request: Request,
  env: ShuttleEnv,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  // Sign-in itself, and the calls GitHub makes, are the only routes that need no sign-in.
  if (url.pathname.startsWith(AUTH_BASE_PATH)) {
    return refuseSignUp(request, env) ?? getAuth(env).handler(request)
  }

  const open = await handlePublicApi(request, env)

  if (open) {
    return open
  }

  const githubPublic = await handleGithubPublicRoutes(request, env)

  if (githubPublic) {
    return githubPublic
  }

  // A runner signs in with its machine's token, not as a browser.
  const runner = await handleRunnerTokenRoutes(request, env)

  if (runner) {
    return runner
  }

  const acting = await workerIdentity(env).resolve(request)
  const actor = acting === null ? null : actorOfActing(acting)

  if (!actor) {
    return Response.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  // A request that names a run is checked against that run before anything else sees it.
  const runId = runIdOfPath(url.pathname)

  if (runId === null && /^\/(?:runs|sessions)\/./.test(url.pathname)) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  if (runId !== null) {
    const denied = await authorizeRun(env, actor, runId)

    if (denied) {
      return denied
    }
  }

  const handled =
    (await handleApi({ env, actor, request, ctx })) ??
    (await handleFirehoseRoutes(request, env, actor)) ??
    (await handleGithubRoutes(request, env, actor)) ??
    (await handleSandboxRoutes(request, env, actor)) ??
    (await handleAssetRoutes(request, env, actor))

  if (handled) {
    return handled
  }

  // What is left is Looms' own API. Looms says which of its routes a request is for; only reads
  // and the signals a browser may send get through, each recorded as this person's.
  if (url.pathname.startsWith('/runs') && runId === null) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  const response = await routeToDurableObject(env.LOOMS_RUN, request, {
    modules: () => {
      // Definitions listing does not need a session-specific sandbox binding.
      return shuttleModules(workerHost(env), 'definitions')
    },
    authorize: (_request, loomsRoute) => authorizeLoomsRoute(env, actor, loomsRoute),
  })

  return response ?? new Response('Not Found', { status: 404 })
}

async function handlePreviewHost(request: Request, env: ShuttleEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const parsed = parsePreviewHost(url.hostname)

  if (!parsed) {
    return null
  }

  // The label is a session's preview key, which leads to the sandbox the session is working in
  // right now, whoever's that is.
  const runId = env.AUTH_DB ? await runOfPreviewKey(env.AUTH_DB, parsed.folderId) : null

  if (runId !== null) {
    const sandboxName = (await loomsStub(env.LOOMS_RUN, runId).getSandboxName()) ?? runId

    return sandboxStub(env, sandboxName).fetch(request)
  }

  // Where each person has their own sandbox there is no folder sandbox to fall back to.
  if (sandboxesArePersonal(env)) {
    return new Response('Preview not found', { status: 404 })
  }

  // Older links carry a sanitized folder id (alphanumeric + hyphen).
  return sandboxStub(env, sandboxNameFor(parsed.folderId)).fetch(request)
}
