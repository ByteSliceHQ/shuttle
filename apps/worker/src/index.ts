import {
  durableObjectLauncher,
  LoomsDurableObject,
  routeToDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'

import { ensurePlaybookQuietly, ensureWorkspaceQuietly } from './bootstrap'
import { resolveProjectors } from './config'
import type { ShuttleEnv } from './env'
import { sandboxStub } from './env'
import { shuttleModules } from './modules'
import { handleGithubRoutes } from './routes/github'
import { handleSandboxRoutes } from './routes/sandbox'
import { handleShuttleRoutes } from './routes/sessions'
import { handleWorkspaceRoutes } from './routes/workspace'
import { parsePreviewHost } from './sandbox/preview-host'
import { SessionSandbox } from './sandbox/session-sandbox'
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
      projectors: resolveProjectors(env, { runId, storage: this.ctx.storage }),
    }
  }
}

export default {
  async fetch(request: Request, env: ShuttleEnv): Promise<Response> {
    const preview = await handlePreviewHost(request, env)

    if (preview) {
      return preview
    }

    const workspace = await handleWorkspaceRoutes(request, env)

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
    if (request.method === 'POST' && new URL(request.url).pathname === '/runs') {
      await ensurePlaybookQuietly(env)
      await ensureWorkspaceQuietly(env)
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
