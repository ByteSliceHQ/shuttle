import {
  durableObjectLauncher,
  LoomsDurableObject,
  routeToDurableObject,
  type LoomsDurableObjectConfig,
} from '@swirls/looms/cloudflare'

import { playbookRunId, resolveProjectors } from './config'
import type { ShuttleEnv } from './env'
import { loomsStub } from './looms-stub'
import { shuttleModules } from './modules'
import { handleShuttleRoutes } from './routes/sessions'
import { SessionSandbox } from './sandbox/session-sandbox'

export { SessionSandbox }

export class LoomsRun extends LoomsDurableObject<ShuttleEnv> {
  override configure(env: ShuttleEnv): LoomsDurableObjectConfig {
    const runId = this.ctx.id.name

    if (!runId) {
      throw new Error('LoomsRun requires a named Durable Object id')
    }

    return {
      modules: shuttleModules(env, runId),
      launcher: durableObjectLauncher(env.LOOMS_RUN),
      projectors: resolveProjectors(env),
    }
  }
}

export default {
  async fetch(request: Request, env: ShuttleEnv): Promise<Response> {
    const shuttle = await handleShuttleRoutes(request, env)

    if (shuttle) {
      return shuttle
    }

    // Ensure the playbook DO exists lazily when a session is started.
    if (request.method === 'POST' && new URL(request.url).pathname === '/runs') {
      await ensurePlaybookQuietly(env)
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

async function ensurePlaybookQuietly(env: ShuttleEnv): Promise<void> {
  const runId = playbookRunId(env)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  try {
    const status = await stub.status()

    if (status) {
      return
    }
  } catch {
    // continue to launch
  }

  try {
    await stub.launch({
      kind: 'reflect-playbook',
      definitionName: 'playbook',
      input: { title: 'Shuttle playbook' },
    })
  } catch {
    // Another request may have created it.
  }
}
