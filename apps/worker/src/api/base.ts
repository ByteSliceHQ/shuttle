import { implement, ORPCError } from '@orpc/server'

import { contract } from '@shuttle/api'
import type { Actor } from '@shuttle/engine/tenancy/access'

import type { ShuttleEnv } from '../env'

/**
 * What every API handler is given. `index.ts` has already signed the request in as `actor` and,
 * for a path that names a run, checked that they may open it.
 */
export interface ApiContext {
  readonly env: ShuttleEnv
  readonly actor: Actor
  readonly request: Request
  readonly ctx?: ExecutionContext
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
