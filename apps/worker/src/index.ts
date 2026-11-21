import { serveShuttle, type ApiModule } from '@shuttle/engine/api/serve'
import { loomsStub } from '@shuttle/engine/looms-stub'
import type { ShuttleHost } from '@shuttle/engine/ports/host'
import {
  EventFirehose,
  SessionSandbox,
  ShuttleRun,
  shuttleApiModules,
} from '@shuttle/engine/worker'
import { sandboxNameFor } from '@shuttle/engine/workspace/thread'
import { httpsRedirect, withHsts } from '@shuttle/sandbox/https'
import { sandboxesArePersonal } from '@shuttle/sandbox/names'
import { isOwnHost, parsePreviewHost } from '@shuttle/sandbox/preview-host'
import type { LoomsDurableObjectConfig } from '@swirls/looms/cloudflare'

import { handleApi } from './api/handler'
import { handlePublicApi } from './api/public'
import { AUTH_BASE_PATH, AuthUnavailableError, getAuth, trustedWebOrigins } from './auth/auth'
import { refuseSignUp } from './auth/signup-code'
import type { ShuttleEnv } from './env'
import { sandboxStub } from './env'
import { workerHost, workerPreviews } from './host'
import { handleGithubPublicRoutes, handleGithubRoutes } from './routes/github'
import { handleRunnerTokenRoutes } from './routes/runners'
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

  // Everything else is for someone signed in: the engine's own modules, then this app's routes.
  // `serveShuttle` finds who is asking and checks the run a path names before any of them answer.
  const serve = serveShuttle(workerHost(env), {
    modules: [...shuttleApiModules, appApi(env)],
    origins: trustedWebOrigins(env),
  })

  return (await serve(request, ctx)) ?? new Response('Not Found', { status: 404 })
}

/**
 * This app's own routes, as one more module beside the engine's: the rest of the API contract
 * (the workspace, connections, runners) and GitHub's. It is offered whatever no other module
 * answered.
 */
function appApi(env: ShuttleEnv): ApiModule {
  return {
    name: 'app',
    claims: () => true,
    handle: async ({ actor, request, ctx, ports, trustedOrigins }) =>
      (await handleApi({ env, actor, request, ctx, ports, trustedOrigins })) ??
      handleGithubRoutes(request, env, actor),
  }
}

async function handlePreviewHost(request: Request, env: ShuttleEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const parsed = parsePreviewHost(url.hostname)

  if (!parsed) {
    return null
  }

  // The label is a session's preview key, which leads to the sandbox the session is working in
  // right now, whoever's that is.
  const runId = (await workerPreviews(env)?.runOf(parsed.folderId)) ?? null

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
