import type { EngineEnv } from '../env'
import { firehoseStub } from '../firehose/stub'
import type { Actor } from '../tenancy/access'

/**
 * Proxy `/firehose/*` onto the organization's EventFirehose Durable Object. Every member can read
 * it: private sessions never write to it (see `firehose/projector.ts`).
 */
export async function handleFirehoseRoutes(
  request: Request,
  env: EngineEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/firehose')) {
    return null
  }

  return firehoseStub(env, actor.orgId).fetch(request)
}
