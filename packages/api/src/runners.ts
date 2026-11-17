import { oc } from '@orpc/contract'
import { z } from 'zod'

/** The id a machine gives itself. The same shape `DEVICE_ID` in the runner protocol accepts. */
export const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Invalid device id')
export type DeviceId = z.infer<typeof DeviceId>

const DeviceParams = z.object({ deviceId: DeviceId })

/** A machine's sandbox: whether its runner is connected, and what the runner said about it. */
export const RunnerMachine = z.object({
  online: z.boolean(),
  device: z.object({ id: z.string(), name: z.string(), platform: z.string() }).optional(),
  backend: z.object({ id: z.string(), label: z.string(), isolation: z.string() }).optional(),
})
export type RunnerMachine = z.infer<typeof RunnerMachine>

/** A machine a person registered, with what is known about its sandbox right now. */
export const RunnerDevice = RunnerMachine.extend({
  deviceId: z.string(),
  name: z.string(),
  platform: z.string(),
  createdAt: z.number(),
})
export type RunnerDevice = z.infer<typeof RunnerDevice>

/**
 * A signed-in person's own machines. What a runner itself asks, with its machine's token, is
 * not here: those routes carry no sign-in.
 */
export const runnersContract = {
  /** Their machines, and whether each is connected. */
  list: oc
    .route({ method: 'GET', path: '/runners' })
    .output(z.object({ devices: z.array(RunnerDevice) })),

  /** Registers a machine. Answers once with the token its runner uses. */
  register: oc
    .route({ method: 'POST', path: '/runners' })
    .input(
      DeviceParams.extend({
        name: z.string().trim().optional(),
        platform: z.string().optional(),
      }),
    )
    .output(z.object({ token: z.string() })),

  get: oc
    .route({ method: 'GET', path: '/runners/{deviceId}' })
    .input(DeviceParams)
    .output(RunnerMachine),

  /** Forgets a machine: its token stops working and its runner is cut off. */
  remove: oc
    .route({ method: 'DELETE', path: '/runners/{deviceId}' })
    .input(DeviceParams)
    .output(z.object({ removed: z.boolean() })),
}
