import { createORPCClient, ORPCError } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

import { clientContract } from '@shuttle/api'

/** What a single call may add to its request. */
export interface CallContext {
  /**
   * This machine's id, sent when a call is about the sandbox on this machine as well as the
   * cloud. Only the desktop app has one.
   */
  readonly deviceId?: string | null
}

const link = new OpenAPILink<CallContext>(clientContract, {
  url: () => window.location.origin,
  headers: ({ context }) => (context.deviceId ? { 'x-shuttle-device': context.deviceId } : {}),
})

/**
 * The Worker's API, typed from the contract in `@shuttle/api`. Call it directly for one-off
 * requests: `await client.sessions.rename({ id, title })`.
 *
 * Everything on the contract is plain JSON (no dates, files or bigints), so what arrives is
 * exactly what the schemas say and the types need no JSON conversion applied.
 */
export const client: ContractRouterClient<typeof clientContract, CallContext> =
  createORPCClient(link)

/**
 * The same API as TanStack Query options, for loaders and components:
 * `api.sessions.team.get.queryOptions({ input: { id } })`, `api.sessions.rename.mutationOptions()`.
 */
export const api = createTanstackQueryUtils(client)

/** The HTTP status a failed call came back with, when it reached the Worker at all. */
export function statusOf(cause: unknown): number | undefined {
  return cause instanceof ORPCError ? cause.status : undefined
}

export function isSignedOut(cause: unknown): boolean {
  return statusOf(cause) === 401
}
