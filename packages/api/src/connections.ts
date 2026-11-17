import { oc } from '@orpc/contract'
import { z } from 'zod'

import { Ok } from './common'
import { AcpHarness, BuiltInHarness, HarnessId, Team, VendorModel } from './harness'

/** The agents offered on the Connections page: every built-in one that signs in with a vendor. */
export const ConnectableHarness = BuiltInHarness.exclude(['shuttle'])
export type ConnectableHarness = z.infer<typeof ConnectableHarness>

/** An agent that runs in the sandbox under the developer's own subscription. */
export const VendorHarness = z.union([ConnectableHarness, AcpHarness])
export type VendorHarness = z.infer<typeof VendorHarness>

export const Connection = z.object({
  harness: ConnectableHarness,
  label: z.string(),
  /** Signed in somewhere: in the cloud, on this machine, or both. */
  connected: z.boolean(),
  /** Signed in in the viewer's cloud sandbox. */
  cloud: z.boolean(),
  /** Signed in on this machine. Null outside the desktop app, where there is no machine. */
  local: z.boolean().nullable(),
  updatedAt: z.number().nullable(),
})
export type Connection = z.infer<typeof Connection>

export const ConnectionsState = z.object({
  /** Whether `local` was asked, which it is from the desktop app. */
  machine: z.boolean(),
  /** The harness new sessions start on. */
  defaultHarness: HarnessId,
  /** The team new Shuttle sessions start with. */
  defaultTeam: Team,
  /** Subscriptions need the container sandbox; `memory` cannot run the agents. */
  mode: z.enum(['memory', 'container']),
  /** False when the worker has no key to encrypt stored sign-ins with. */
  canStore: z.boolean(),
  connections: z.array(Connection).readonly(),
})
export type ConnectionsState = z.infer<typeof ConnectionsState>

/** What new sessions start with. */
export const SessionDefaults = z.object({ defaultHarness: HarnessId, defaultTeam: Team })
export type SessionDefaults = z.infer<typeof SessionDefaults>

/** Where an event sits in the sign-in's event file. `seq` starts at 1 and has no gaps. */
const LoginEventPosition = { seq: z.number(), at: z.number() }

/** What the vendor CLI said while signing in. */
export const LoginEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('login_prompt'),
    url: z.string(),
    /** A code to enter at `url`. Empty when the agent expects a code back instead. */
    code: z.string(),
    /** True when the user must paste a code from `url` back to the agent to finish. */
    needsCode: z.boolean().optional(),
    ...LoginEventPosition,
  }),
  z.object({
    type: z.literal('login_done'),
    success: z.boolean(),
    error: z.string().optional(),
    ...LoginEventPosition,
  }),
])
export type LoginEvent = z.infer<typeof LoginEvent>

/** A sign-in's events from one offset on, and whether it has connected the agent. */
export const LoginProgress = z.object({
  events: z.array(LoginEvent),
  /** Pass this as `offset` on the next read. */
  offset: z.number(),
  /** True once the sign-in has ended. Nothing follows. */
  done: z.boolean(),
  connected: z.boolean(),
  error: z.string().optional(),
})
export type LoginProgress = z.infer<typeof LoginProgress>

/**
 * The agent a `/workspace/connections/{harness}/…` path names. Any text is accepted here so the
 * Worker can answer 404 for an agent it does not know, as it does for any other missing thing.
 */
export const ConnectionParams = z.object({ harness: z.string().min(1) })

/** The sign-in a `/workspace/connections/{harness}/login/{loginId}/…` path names. */
export const LoginParams = ConnectionParams.extend({
  loginId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
})

/**
 * Connecting a coding agent subscription. Sign-in is always the vendor CLI's own flow, run in a
 * sandbox container: Shuttle shows the link or code the CLI prints and passes back what the CLI
 * asks for.
 */
export const connectionsContract = {
  list: oc.route({ method: 'GET', path: '/workspace/connections' }).output(ConnectionsState),

  /** Sets the harness and team new sessions start with. Either may be left out to keep it. */
  setDefault: oc
    .route({ method: 'PUT', path: '/workspace/connections/default' })
    .input(z.object({ harness: HarnessId.optional(), team: Team.optional() }))
    .output(SessionDefaults),

  disconnect: oc
    .route({ method: 'DELETE', path: '/workspace/connections/{harness}' })
    .input(ConnectionParams)
    .output(z.object({ removed: z.boolean() })),

  /** The models the agent offers. */
  models: oc
    .route({ method: 'GET', path: '/workspace/connections/{harness}/models' })
    .input(ConnectionParams)
    .output(z.object({ harness: VendorHarness, models: z.array(VendorModel).readonly() })),

  login: {
    start: oc
      .route({ method: 'POST', path: '/workspace/connections/{harness}/login' })
      .input(ConnectionParams)
      .output(z.object({ loginId: z.string() })),

    follow: oc
      .route({ method: 'GET', path: '/workspace/connections/{harness}/login/{loginId}' })
      .input(LoginParams.extend({ offset: z.coerce.number().int().min(0).optional() }))
      .output(LoginProgress),

    /** Passes back a code the vendor CLI asked for. */
    sendCode: oc
      .route({ method: 'POST', path: '/workspace/connections/{harness}/login/{loginId}/code' })
      .input(LoginParams.extend({ code: z.string().trim().min(1) }))
      .output(Ok),

    cancel: oc
      .route({ method: 'POST', path: '/workspace/connections/{harness}/login/{loginId}/cancel' })
      .input(LoginParams)
      .output(Ok),
  },
}
