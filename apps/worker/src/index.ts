import {
  durableObjectLauncher,
  LoomsDurableObject,
  routeToDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'

import { shuttleAttributes } from './attributes'
import { ensurePlaybookQuietly, ensurePullsQuietly, ensureWorkspaceQuietly } from './bootstrap'
import { readStoredLlmModel, resolveProjectors, writeStoredLlmModel } from './config'
import type { ShuttleEnv } from './env'
import { sandboxStub } from './env'
import { shuttleModules } from './modules'
import { handleGithubRoutes } from './routes/github'
import { handleSandboxRoutes } from './routes/sandbox'
import { handleShuttleRoutes } from './routes/sessions'
import { handleWorkspaceRoutes } from './routes/workspace'
import { parsePreviewHost } from './sandbox/preview-host'
import { SessionSandbox } from './sandbox/session-sandbox'
import { deriveActivityFromRunState } from './workspace/activity-state'
import type { SessionActivity } from './workspace/module'
import { sandboxNameFor } from './workspace/thread'

export { SessionSandbox }

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
