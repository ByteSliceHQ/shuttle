import { RUNNER_CONNECT_PATH } from '@shuttle/runner-protocol'

import { sandboxStub, type ShuttleEnv } from '../env'
import { localSandboxName } from '../sandbox/names'
import { bearerToken, deviceOfToken } from '../tenancy/devices'

/**
 * Runners: the processes that keep a sandbox on a person's own machine.
 *
 * What a signed-in person asks about their own machines is on the API contract, in
 * `api/runners.ts`.
 *
 * Asked by a runner, with its machine's token and no sign-in:
 *
 *   GET /runners/self        whose machine the token is for
 *   GET /runners/connect     the runner's WebSocket, held open for as long as it runs
 *
 * A machine's sandbox is named after its owner, and a token leads to exactly one machine, so a
 * machine only ever serves its owner and a runner cannot connect as anyone else.
 */

const SELF_PATH = '/runners/self'

/** The routes a runner calls. Null for any other request, which then needs a sign-in. */
export async function handleRunnerTokenRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url)

  if (pathname !== RUNNER_CONNECT_PATH && pathname !== SELF_PATH) {
    return null
  }

  const token = bearerToken(request)

  const device =
    token !== null && token !== '' && env.AUTH_DB ? await deviceOfToken(env.AUTH_DB, token) : null

  if (!device) {
    return Response.json(
      { error: 'This machine is not registered with Shuttle, or was removed.' },
      { status: 401 },
    )
  }

  if (pathname === SELF_PATH) {
    return Response.json({
      userId: device.userId,
      orgId: device.orgId,
      deviceId: device.deviceId,
    })
  }

  return sandboxStub(env, localSandboxName(device.orgId, device.userId, device.deviceId)).fetch(
    request,
  )
}
