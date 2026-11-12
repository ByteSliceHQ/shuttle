import type { ShuttleEnv } from '../env'
import { firehoseStub } from '../firehose/stub'

/** Proxy `/firehose/*` onto the singleton EventFirehose Durable Object. */
export async function handleFirehoseRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/firehose')) {
    return null
  }

  return firehoseStub(env).fetch(request)
}
