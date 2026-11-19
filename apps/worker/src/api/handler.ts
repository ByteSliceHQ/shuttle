import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { ORPCError } from '@orpc/server'

import { MAX_ASSET_BYTES, formatBytes } from '@shuttle/engine/assets/store'

import { trustedWebOrigins } from '../auth/auth'
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

function refusal(code: string, status: number, message: string) {
  const error = new ORPCError(code, { status, message })

  return Response.json({ ...error.toJSON(), error: message }, { status: error.status })
}

/**
 * Checks a multipart body before it is read. A form post is a "simple" request that browsers
 * send from other sites without asking first, so it must come from the app's own pages; and its
 * declared length, which HTTP framing holds it to, must be within the limit for attachments.
 */
export function refuseMultipart(context: ApiContext): Response | null {
  const { request, env } = context

  if (
    request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data') !== true
  ) {
    return null
  }

  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')

  if (
    (site !== null && site !== 'same-origin' && site !== 'none') ||
    (origin !== null && !trustedWebOrigins(env).includes(origin))
  ) {
    return refusal('FORBIDDEN', 403, 'Files can only be sent from Shuttle itself.')
  }

  const length = request.headers.get('content-length')

  if (length === null) {
    return refusal('LENGTH_REQUIRED', 411, 'Send files with a declared length.')
  }

  if (!(Number(length) <= MAX_ASSET_BYTES)) {
    return refusal(
      'PAYLOAD_TOO_LARGE',
      413,
      `Files can total up to ${formatBytes(MAX_ASSET_BYTES)}.`,
    )
  }

  return null
}

/** Answers a request for a route in the contract, or null when it is for something else. */
export async function handleApi(context: ApiContext): Promise<Response | null> {
  const refused = refuseMultipart(context)

  if (refused) {
    return refused
  }

  const { matched, response } = await handler.handle(context.request, { context })

  return matched ? response : null
}
