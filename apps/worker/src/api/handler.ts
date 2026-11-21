import { apiHandler, engineRouter, refuseMultipart } from '@shuttle/engine/api/handler'

import type { ApiContext } from './base'
import { connectionsRouter } from './connections'
import { githubRouter } from './github'
import { runnersRouter } from './runners'
import { tenantRouter } from './tenant'
import { timingsRouter } from './timings'
import { workspaceRouter } from './workspace'

export { refuseMultipart }

/**
 * The whole API contract: the routes the engine answers by itself (a session, its playbook, its
 * sandbox) beside the ones that are this app's own.
 */
export const router = {
  ...engineRouter,
  connections: connectionsRouter,
  workspace: workspaceRouter,
  github: githubRouter,
  runners: runnersRouter,
  timings: timingsRouter,
  tenant: tenantRouter,
}

const handle = apiHandler(router)

/** Answers a request for a route in the contract, or null when it is for something else. */
export function handleApi(context: ApiContext): Promise<Response | null> {
  return handle(context)
}
