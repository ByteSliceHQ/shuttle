import { DEVICE_ID, RUNNER_CONNECT_PATH } from '@shuttle/runner-protocol'

import { sandboxStub, type ShuttleEnv } from '../env'
import { localSandboxName } from '../sandbox/names'
import type { Actor } from '../tenancy/access'
import {
  bearerToken,
  deviceOfToken,
  listDevices,
  registerDevice,
  removeDevice,
} from '../tenancy/devices'

/**
 * Runners: the processes that keep a sandbox on a person's own machine.
 *
 * Asked by a signed-in person, about their own machines:
 *
 *   GET    /runners          their machines, and whether each is connected
 *   POST   /runners          register a machine; answers once with the token its runner uses
 *   GET    /runners/<id>     one machine
 *   DELETE /runners/<id>     forget a machine: its token stops working and its runner is cut off
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
  const device = token && env.AUTH_DB ? await deviceOfToken(env.AUTH_DB, token) : null

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

export async function handleRunnerRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const { pathname } = new URL(request.url)

  if (pathname !== '/runners' && !pathname.startsWith('/runners/')) {
    return null
  }

  if (!env.AUTH_DB) {
    return Response.json({ error: 'Local sandboxes are unavailable' }, { status: 503 })
  }

  const sandboxOf = (deviceId: string) =>
    sandboxStub(env, localSandboxName(actor.orgId, actor.userId, deviceId))

  const describe = (deviceId: string) =>
    sandboxOf(deviceId)
      .describe()
      .catch(() => ({ online: false }))

  if (pathname === '/runners') {
    if (request.method === 'GET') {
      const devices = await listDevices(env.AUTH_DB, actor.orgId, actor.userId)

      return Response.json({
        devices: await Promise.all(
          devices.map(async (device) => ({
            deviceId: device.deviceId,
            name: device.name,
            platform: device.platform,
            createdAt: device.createdAt,
            ...(await describe(device.deviceId)),
          })),
        ),
      })
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    const body = (await request.json().catch(() => null)) as {
      deviceId?: unknown
      name?: unknown
      platform?: unknown
    } | null

    if (typeof body?.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId)) {
      return Response.json({ error: 'Invalid device id' }, { status: 400 })
    }

    return Response.json(
      await registerDevice(env.AUTH_DB, {
        orgId: actor.orgId,
        userId: actor.userId,
        deviceId: body.deviceId,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'This machine',
        platform: typeof body.platform === 'string' ? body.platform : 'unknown',
      }),
    )
  }

  const deviceId = decodeURIComponent(pathname.slice('/runners/'.length))

  if (!DEVICE_ID.test(deviceId)) {
    return Response.json({ error: 'Invalid device id' }, { status: 400 })
  }

  if (request.method === 'GET') {
    return Response.json(await describe(deviceId))
  }

  if (request.method !== 'DELETE') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const removed = await removeDevice(env.AUTH_DB, actor.orgId, actor.userId, deviceId)

  // The token is gone, so the runner that is cut off here cannot come back.
  await sandboxOf(deviceId)
    .disconnect()
    .catch(() => {})

  return Response.json({ removed })
}
