import { ORPCError } from '@orpc/server'

import { sandboxStub, type ShuttleEnv } from '../env'
import { localSandboxName } from '../sandbox/names'
import type { Actor } from '../tenancy/access'
import { listDevices, registerDevice, removeDevice } from '../tenancy/devices'
import { api } from './base'

/**
 * Runners: the processes that keep a sandbox on a person's own machine. These are the routes a
 * signed-in person asks about their own machines:
 *
 *   GET    /runners          their machines, and whether each is connected
 *   POST   /runners          register a machine; answers once with the token its runner uses
 *   GET    /runners/<id>     one machine
 *   DELETE /runners/<id>     forget a machine: its token stops working and its runner is cut off
 *
 * What a runner asks with its machine's token is in `routes/runners.ts`.
 *
 * A machine's sandbox is named after its owner, and a token leads to exactly one machine, so a
 * machine only ever serves its owner and a runner cannot connect as anyone else.
 */

function devicesDb(env: ShuttleEnv): D1Database {
  if (!env.AUTH_DB) {
    throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Local sandboxes are unavailable' })
  }

  return env.AUTH_DB
}

function sandboxOf(env: ShuttleEnv, actor: Actor, deviceId: string) {
  return sandboxStub(env, localSandboxName(actor.orgId, actor.userId, deviceId))
}

function describe(env: ShuttleEnv, actor: Actor, deviceId: string) {
  return sandboxOf(env, actor, deviceId)
    .describe()
    .catch(() => ({ online: false }))
}

export const runnersRouter = {
  list: api.runners.list.handler(async ({ context: { env, actor } }) => {
    const devices = await listDevices(devicesDb(env), actor.orgId, actor.userId)

    return {
      devices: await Promise.all(
        devices.map(async (device) => ({
          deviceId: device.deviceId,
          name: device.name,
          platform: device.platform,
          createdAt: device.createdAt,
          ...(await describe(env, actor, device.deviceId)),
        })),
      ),
    }
  }),

  register: api.runners.register.handler(({ input, context: { env, actor } }) =>
    registerDevice(devicesDb(env), {
      orgId: actor.orgId,
      userId: actor.userId,
      deviceId: input.deviceId,
      name: input.name === undefined || input.name === '' ? 'This machine' : input.name,
      platform: input.platform ?? 'unknown',
    }),
  ),

  get: api.runners.get.handler(({ input, context: { env, actor } }) => {
    devicesDb(env)

    return describe(env, actor, input.deviceId)
  }),

  remove: api.runners.remove.handler(async ({ input, context: { env, actor } }) => {
    const removed = await removeDevice(devicesDb(env), actor.orgId, actor.userId, input.deviceId)

    // The token is gone, so the runner that is cut off here cannot come back.
    await sandboxOf(env, actor, input.deviceId)
      .disconnect()
      .catch(() => {})

    return { removed }
  }),
}
