import {
  durableObjectLauncher,
  LoomsDurableObject,
  routeToDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'

import { shuttleAttributes } from './attributes'
import { ensurePlaybookQuietly, ensurePullsQuietly, ensureWorkspaceQuietly } from './bootstrap'
import {
  readStoredLlmModel,
  resolveProjectors,
  workspaceRunId,
  writeStoredLlmModel,
} from './config'
import {
  createCredentialStore,
  DEPLOYMENT_OWNER,
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
import { loomsStub } from './looms-stub'
import { shuttleModules } from './modules'
import { handleConnectionRoutes } from './routes/connections'
import { handleFirehoseRoutes } from './routes/firehose'
import { handleGithubRoutes } from './routes/github'
import { handleSandboxRoutes } from './routes/sandbox'
import { handleShuttleRoutes } from './routes/sessions'
import { handleWorkspaceRoutes } from './routes/workspace'
import { parsePreviewHost } from './sandbox/preview-host'
import { SessionSandbox } from './sandbox/session-sandbox'
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
    }
  }

  /** OpenRouter model id used by agent LLM turns for this run. */
  async getLlmModel(): Promise<{ model: string }> {
    return { model: await readStoredLlmModel(this.ctx.storage, this.env) }
  }

  async setLlmModel(model: string): Promise<{ model: string }> {
    return { model: await writeStoredLlmModel(this.ctx.storage, model) }
  }

  /** Which agent runs this session: Shuttle's own loop or a vendor agent in the sandbox. */
  async getHarness(): Promise<{ harness: HarnessId }> {
    const pinned = await readPinnedHarness(this.ctx.storage)
    const workspace = workspaceRunId(this.env)

    // A session that has not run a turn yet will take the workspace default when it does.
    if (pinned || this.ctx.id.name === workspace) {
      return { harness: pinned ?? DEFAULT_HARNESS }
    }

    return loomsStub(this.env.LOOMS_RUN, workspace).getHarness()
  }

  async setHarness(harness: string): Promise<{ harness: HarnessId }> {
    return { harness: await writeStoredHarness(this.ctx.storage, harness) }
  }

  /**
   * Stored vendor agent sign-ins. Only the workspace run holds them, so callers reach these
   * through `credentialsStub`.
   */
  private credentialStore(): CredentialStore {
    return createCredentialStore({
      storage: this.ctx.storage,
      secret: this.env.SHUTTLE_CREDENTIALS_KEY,
    })
  }

  async getCredential(harness: VendorHarnessId): Promise<CredentialPayload | null> {
    return this.credentialStore().get(DEPLOYMENT_OWNER, harness)
  }

  async putCredential(harness: VendorHarnessId, payload: CredentialPayload): Promise<void> {
    await this.credentialStore().put(DEPLOYMENT_OWNER, harness, payload)
  }

  async removeCredential(harness: VendorHarnessId): Promise<boolean> {
    return this.credentialStore().remove(DEPLOYMENT_OWNER, harness)
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    return this.credentialStore().list(DEPLOYMENT_OWNER)
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
    const preview = await handlePreviewHost(request, env)

    if (preview) {
      return preview
    }

    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true })
    }

    const firehose = await handleFirehoseRoutes(request, env)

    if (firehose) {
      return firehose
    }

    const connections = await handleConnectionRoutes(request, env)

    if (connections) {
      return connections
    }

    const workspace = await handleWorkspaceRoutes(request, env, ctx)

    if (workspace) {
      return workspace
    }

    const github = await handleGithubRoutes(request, env)

    if (github) {
      return github
    }

    const sandbox = await handleSandboxRoutes(request, env)

    if (sandbox) {
      return sandbox
    }

    const shuttle = await handleShuttleRoutes(request, env)

    if (shuttle) {
      return shuttle
    }

    // Ensure the playbook DO exists lazily when a session is started.
    if (
      request.method === 'POST' &&
      (url.pathname === '/runs' || url.pathname === '/runs/launch')
    ) {
      await Promise.all([
        ensurePlaybookQuietly(env),
        ensureWorkspaceQuietly(env),
        ensurePullsQuietly(env),
      ])
    }

    const response = await routeToDurableObject(env.LOOMS_RUN, request, {
      modules: () => {
        // Definitions listing does not need a session-specific sandbox binding.
        return shuttleModules(env, 'definitions')
      },
    })

    return response ?? new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<ShuttleEnv>

async function handlePreviewHost(request: Request, env: ShuttleEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const parsed = parsePreviewHost(url.hostname)

  if (!parsed) {
    return null
  }

  // Hostname label is a sanitized folder id (alphanumeric + hyphen).
  const sandboxName = sandboxNameFor(parsed.folderId)
  const stub = sandboxStub(env, sandboxName)
  return stub.fetch(request)
}
