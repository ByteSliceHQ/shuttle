import { implement } from '@orpc/server'

import { contract } from '@shuttle/api'
import type { ApiContext as EngineApiContext } from '@shuttle/engine/api/base'

import type { ShuttleEnv } from '../env'

export { badRequest, forbidden, notFound } from '@shuttle/engine/api/base'

/**
 * What every API handler here is given: what the engine's handlers get, with this Worker's whole
 * environment. `index.ts` has already signed the request in as `actor` and, for a path that names
 * a run, checked that they may open it.
 */
export type ApiContext = EngineApiContext<ShuttleEnv>

/** The contract, ready to implement. Inputs and outputs are validated against it. */
export const api = implement(contract).$context<ApiContext>()
