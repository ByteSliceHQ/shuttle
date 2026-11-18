import {
  durableObjectLauncher,
  LoomsDurableObject,
  routeToDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'
import { forwardedActorAuth } from '@swirls/looms/runtime'

import { handleApi } from './api/handler'
import { handlePublicApi } from './api/public'
import { shuttleAttributes } from './attributes'
import { resolveActor } from './auth/actor'
import { AUTH_BASE_PATH, AuthUnavailableError, getAuth } from './auth/auth'
import { refuseSignUp } from './auth/signup-code'
import {
  readStoredLlmModel,
  resolveProjectors,
  workspaceRunId,
  writeStoredLlmModel,
} from './config'
import {
  createCredentialStore,
  type CredentialPayload,
  type CredentialStore,
  type CredentialSummary,
} from './credentials/store'
import type { ShuttleEnv } from './env'
import { sandboxStub } from './env'
import { EventFirehose } from './firehose/durable-object'
import {
  DEFAULT_HARNESS,
  readPinnedHarness,
  writeStoredHarness,
  type HarnessId,
  type VendorHarnessId,
} from './harness'
import { httpsRedirect, withHsts } from './https'
import { loomsStub } from './looms-stub'
import { shuttleModules } from './modules'
import { handleAssetRoutes } from './routes/assets'
import { handleFirehoseRoutes } from './routes/firehose'
import { handleGithubPublicRoutes, handleGithubRoutes } from './routes/github'
import { handleRunnerTokenRoutes } from './routes/runners'
import { handleSandboxRoutes } from './routes/sandbox'
import { sandboxesArePersonal } from './sandbox/names'
import { isOwnHost, parsePreviewHost } from './sandbox/preview-host'
import { SessionSandbox } from './sandbox/session-sandbox'
import {
  readSandboxBinding,
  readSandboxPlacement,
  sandboxNameForSession,
  writeSandboxPlacement,
  type SandboxBinding,
  type SandboxPlacement,
} from './session/bind-sandbox'
import {
  LAST_MOVE_KEY,
  PENDING_PLACEMENT_KEY,
  prepareSessionSandbox,
  SANDBOX_HOME_KEY,
  type PendingPlacement,
  type SessionMove,
} from './session/handoff'
import { DEFAULT_TEAM, readPinnedTeam, writeStoredTeam, type Team } from './team'
import { readSessionAccess, writeSessionAccess, type SessionAccess } from './tenancy/access'
import { authorizeLoomsRoute, authorizeRun, runIdOfPath } from './tenancy/gate'
import { runOfPreviewKey } from './tenancy/previews'
import { orgOfRun } from './tenancy/run-id'
import { runTimingObserver } from './timing'
import { CONNECTABLE_HARNESSES } from './vendor/harnesses'
import {
  readVendorCatalogue,
  readVendorModelChoice,
  writeVendorCatalogue,
  writeVendorModelChoice,
  type VendorCatalogue,
  type VendorModel,
  type VendorModelChoice,
  type VendorModelChoices,
} from './vendor/models'
import { isWebAppRequest } from './web-app'
import { deriveActivityFromRunState } from './workspace/activity-state'
import type { SessionActivity } from './workspace/module'
import { sandboxNameFor } from './workspace/thread'

export { EventFirehose, SessionSandbox }

export class LoomsRun extends LoomsDurableObject<ShuttleEnv> {
  override configure(env: ShuttleEnv): LoomsDurableObjectConfig {
    const runId = this.ctx.id.name

    if (!runId) {
      throw new Error('LoomsRun requires a named Durable Object id')
    }

    return {
      modules: shuttleModules(env, runId, { storage: this.ctx.storage }),
      launcher: durableObjectLauncher(env.LOOMS_RUN),
      attributes: shuttleAttributes,
      projectors: resolveProjectors(env, { runId, storage: this.ctx.storage }),
      // Only the Worker reaches this object, and it has already decided the request. It says who
      // the request acts as, and that is recorded on the events the request sends.
      authorize: forwardedActorAuth(),
      observer: runTimingObserver(runId),
    }
  }

  /** OpenRouter model id used by agent LLM turns for this run. */
  async getLlmModel(): Promise<{ model: string }> {
    return { model: await readStoredLlmModel(this.ctx.storage, this.env) }
  }

  async setLlmModel(model: string): Promise<{ model: string }> {
    return { model: await writeStoredLlmModel(this.ctx.storage, model) }
  }

  /** The workspace run of this run's organization, which holds the organization's defaults. */
  private workspaceRun(): string {
    return workspaceRunId(this.env, orgOfRun(this.ctx.id.name ?? ''))
  }

  /** Who may open this session. Null when no one has been recorded, see `tenancy/access.ts`. */
  async getAccess(): Promise<SessionAccess | null> {
    return readSessionAccess(this.ctx.storage)
  }

  async setAccess(access: unknown): Promise<SessionAccess> {
    return writeSessionAccess(this.ctx.storage, access)
  }

  /**
   * The sandbox that holds this session's files, or null when it has not bound one yet. That is
   * where it last worked. Before it has worked anywhere, it is where its next turn will run.
   */
  async getSandboxName(): Promise<string | null> {
    const runId = this.ctx.id.name ?? ''
    const binding = await readSandboxBinding(this.ctx.storage, runId)

    if (!binding) {
      return null
    }

    return (
      (await this.ctx.storage.get<string>(SANDBOX_HOME_KEY)) ??
      sandboxNameForSession(this.env, this.ctx.storage, runId, binding.sandboxName)
    )
  }

  /** The machine a person asked for this session to run on, or null for the cloud. */
  async getSandboxPlacement(): Promise<SandboxPlacement | null> {
    return readSandboxPlacement(this.ctx.storage)
  }

  /**
   * Moves this session to one of a person's own machines, or back to the cloud with null. A
   * session that has already worked somewhere is moved now, files and all, so the person sees
   * it arrive; one that has not simply starts there. If the move fails the session stays where
   * it was. `moved` says what was carried, when anything was.
   */
  async placeSandbox(
    placement: SandboxPlacement | null,
  ): Promise<{ sandboxName: string | null; moved: SessionMove | null }> {
    const runId = this.ctx.id.name ?? ''
    const before = await readSandboxPlacement(this.ctx.storage)
    const binding = await readSandboxBinding(this.ctx.storage, runId)
    const lastMove = await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)

    await this.ctx.storage.delete(PENDING_PLACEMENT_KEY)
    await writeSandboxPlacement(this.ctx.storage, placement)

    if (!binding) {
      return { sandboxName: null, moved: null }
    }

    try {
      await prepareSessionSandbox(this.env, this.ctx.storage, runId, binding)
    } catch (cause) {
      await writeSandboxPlacement(this.ctx.storage, before)

      throw cause
    }

    const move = await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)

    return {
      sandboxName: await this.getSandboxName(),
      moved: move && move.at !== lastMove?.at ? move : null,
    }
  }

  /** Asks for a move that happens when the session next stops working. */
  async placeSandboxLater(placement: SandboxPlacement | null): Promise<{ ok: true }> {
    await this.ctx.storage.put(PENDING_PLACEMENT_KEY, { placement } satisfies PendingPlacement)

    return { ok: true }
  }

  /** What is known about where this session is going and where it last came from. */
  async getSandboxMoves(): Promise<{
    pending: PendingPlacement | null
    last: SessionMove | null
  }> {
    return {
      pending: (await this.ctx.storage.get<PendingPlacement>(PENDING_PLACEMENT_KEY)) ?? null,
      last: (await this.ctx.storage.get<SessionMove>(LAST_MOVE_KEY)) ?? null,
    }
  }

  /** The repositories this session works in. Empty before it binds a sandbox, or with none linked. */
  async getSessionRepos(): Promise<SandboxBinding['repos']> {
    return (await readSandboxBinding(this.ctx.storage, this.ctx.id.name ?? ''))?.repos ?? []
  }

  /** Which agent runs this session: Shuttle's own loop or a vendor agent in the sandbox. */
  async getHarness(): Promise<{ harness: HarnessId }> {
    const pinned = await readPinnedHarness(this.ctx.storage)
    const workspace = this.workspaceRun()

    // A session that has not run a turn yet will take the workspace default when it does.
    if (pinned || this.ctx.id.name === workspace) {
      return { harness: pinned ?? DEFAULT_HARNESS }
    }

    return loomsStub(this.env.LOOMS_RUN, workspace).getHarness()
  }

  async setHarness(harness: string): Promise<{ harness: HarnessId }> {
    return { harness: await writeStoredHarness(this.ctx.storage, harness) }
  }

  /** Who the conductor may delegate to in this session. The workspace run holds the default. */
  async getTeam(): Promise<{ team: Team }> {
    const pinned = await readPinnedTeam(this.ctx.storage)
    const workspace = this.workspaceRun()

    if (pinned || this.ctx.id.name === workspace) {
      return { team: pinned ?? DEFAULT_TEAM }
    }

    return loomsStub(this.env.LOOMS_RUN, workspace).getTeam()
  }

  async setTeam(team: unknown): Promise<{ team: Team }> {
    return { team: await writeStoredTeam(this.ctx.storage, team) }
  }

  /**
   * The model and effort chosen for each vendor agent on this run. The workspace run holds the
   * most recent choice, which sessions without one of their own fall back to.
   */
  async getVendorModelChoices(): Promise<{ choices: VendorModelChoices }> {
    const choices: VendorModelChoices = {}

    for (const harness of CONNECTABLE_HARNESSES) {
      const choice = await readVendorModelChoice(this.ctx.storage, harness)

      if (choice) {
        choices[harness] = choice
      }
    }

    return { choices }
  }

  async setVendorModelChoice(
    harness: VendorHarnessId,
    choice: unknown,
  ): Promise<{ choice: VendorModelChoice }> {
    return { choice: await writeVendorModelChoice(this.ctx.storage, harness, choice) }
  }

  /** An agent's own model list, kept on the workspace run so it is not fetched on every open. */
  async getVendorCatalogue(harness: VendorHarnessId): Promise<VendorCatalogue | null> {
    return readVendorCatalogue(this.ctx.storage, harness)
  }

  async putVendorCatalogue(
    harness: VendorHarnessId,
    models: readonly VendorModel[],
  ): Promise<VendorCatalogue> {
    return writeVendorCatalogue(this.ctx.storage, harness, models)
  }

  /**
   * Stored vendor agent sign-ins, kept per person. Only the workspace run holds them, so callers
   * reach these through the workspace run's stub and say whose sign-in they mean.
   */
  private credentialStore(): CredentialStore {
    return createCredentialStore({
      storage: this.ctx.storage,
      secret: this.env.SHUTTLE_CREDENTIALS_KEY,
    })
  }

  async getCredential(userId: string, harness: VendorHarnessId): Promise<CredentialPayload | null> {
    return this.credentialStore().get(userId, harness)
  }

  async putCredential(
    userId: string,
    harness: VendorHarnessId,
    payload: CredentialPayload,
  ): Promise<void> {
    await this.credentialStore().put(userId, harness, payload)
  }

  async removeCredential(userId: string, harness: VendorHarnessId): Promise<boolean> {
    return this.credentialStore().remove(userId, harness)
  }

  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    return this.credentialStore().list(userId)
  }

  /** Authoritative log tail for this run. */
  async getStreamTail(): Promise<number> {
    const runId = this.ctx.id.name

    if (!runId) {
      return 0
    }

    const [row] = [
      ...this.ctx.storage.sql.exec('SELECT tail FROM looms_streams WHERE run_id = ?', runId),
    ]

    return row && typeof row.tail === 'number' && Number.isFinite(row.tail) ? row.tail : 0
  }

  /** Authoritative session activity + committed log tail for workspace reconciliation. */
  async getSessionActivitySnapshot(): Promise<{
    activity: SessionActivity
    tail: number
  } | null> {
    const runId = this.ctx.id.name

    if (!runId) {
      return null
    }

    const run = await this.getRun()

    if (!run.rootThreadId) {
      return null
    }

    return {
      activity: deriveActivityFromRunState(run),
      tail: await this.getStreamTail(),
    }
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

  const actor = await resolveActor(getAuth(env), request)

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
      return shuttleModules(env, 'definitions')
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

  if (runId) {
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
