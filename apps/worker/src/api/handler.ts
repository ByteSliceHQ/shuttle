import { OpenAPIHandler } from '@orpc/openapi/fetch'

import { api, type ApiContext } from './base'
import { connectionsRouter } from './connections'
import { githubRouter } from './github'
import { runnersRouter } from './runners'
import { sandboxRouter } from './sandbox'
import { playbookRouter, sessionsRouter } from './sessions'
import { tenantRouter } from './tenant'
import { timingsRouter } from './timings'
import { workspaceRouter } from './workspace'

export const router = api.router({
  sessions: sessionsRouter,
  playbook: playbookRouter,
  connections: connectionsRouter,
  workspace: workspaceRouter,
  sandbox: sandboxRouter,
  github: githubRouter,
  runners: runnersRouter,
  timings: timingsRouter,
  tenant: tenantRouter,
})

const handler = new OpenAPIHandler(router, {
  // `error` is what older clients (the desktop app, the runner) read a failure's reason from.
  customErrorResponseBodyEncoder: (error) => ({ ...error.toJSON(), error: error.message }),
})

/** Answers a request for a route in the contract, or null when it is for something else. */
export async function handleApi(context: ApiContext): Promise<Response | null> {
  const { matched, response } = await handler.handle(context.request, { context })

  return matched ? response : null
}
