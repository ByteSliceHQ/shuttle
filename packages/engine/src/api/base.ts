import { implement, ORPCError } from '@orpc/server'

import { contract } from '@shuttle/api'

import type { EngineEnv } from '../env'
import type { HostPorts } from '../ports/host'
import type { Actor } from '../tenancy/access'

/**
 * What every API handler is given. Whoever serves the API has already found who the request acts
 * for (`actor`) and, for a path that names a run, checked that they may open it (`gate.ts`).
 */
export interface ApiContext<Env extends EngineEnv = EngineEnv> {
  readonly env: Env
  readonly actor: Actor
  readonly request: Request
  readonly ctx?: ExecutionContext
  /** The host's ports. What it left out is what a standalone Shuttle does. */
  readonly ports?: Partial<HostPorts>
  /**
   * The origins a form post may come from: the pages that embed Shuttle. Left out, it is the
   * origin of `env.SHUTTLE_WEB_URL`.
   */
  readonly trustedOrigins?: readonly string[]
}

/** The contract, ready to implement. Inputs and outputs are validated against it. */
export const api = implement(contract).$context<ApiContext>()

export function badRequest(message: string): ORPCError<'BAD_REQUEST', undefined> {
  return new ORPCError('BAD_REQUEST', { message })
}

export function forbidden(message: string): ORPCError<'FORBIDDEN', undefined> {
  return new ORPCError('FORBIDDEN', { message })
}

export function notFound(message: string): ORPCError<'NOT_FOUND', undefined> {
  return new ORPCError('NOT_FOUND', { message })
}
