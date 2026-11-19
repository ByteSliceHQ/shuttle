import { firehoseStub } from '@shuttle/engine/firehose/stub'
import type { Actor } from '@shuttle/engine/tenancy/access'

import type { ShuttleEnv } from '../env'

/**
 * Proxy `/firehose/*` onto the organization's EventFirehose Durable Object. Every member can read
 * it: private sessions never write to it (see `firehose/projector.ts`).
 */
export async function handleFirehoseRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/firehose')) {
    return null
  }

  return firehoseStub(env, actor.orgId).fetch(request)
}
