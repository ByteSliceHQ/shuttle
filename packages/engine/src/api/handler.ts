import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { ORPCError, type AnyRouter } from '@orpc/server'

import { MAX_ASSET_BYTES, formatBytes } from '../assets/store'
import type { ApiContext } from './base'
import { sandboxRouter } from './sandbox'
import { playbookRouter, sessionsRouter } from './sessions'

/**
 * The part of the API contract the engine answers by itself: a session, its playbook and its
 * sandbox. A host serves these as they are (`serve.ts`), or puts them in a router of its own
 * beside routes it adds, as Shuttle's own app does.
 */
export const engineRouter = {
  sessions: sessionsRouter,
  playbook: playbookRouter,
  sandbox: sandboxRouter,
}

function refusal(code: string, status: number, message: string) {
  const error = new ORPCError(code, { status, message })

  return Response.json({ ...error.toJSON(), error: message }, { status: error.status })
}

function trustedOrigins(context: ApiContext): readonly string[] {
  if (context.trustedOrigins !== undefined) {
    return context.trustedOrigins
  }

  const web = context.env.SHUTTLE_WEB_URL

  return web !== undefined && URL.canParse(web) ? [new URL(web).origin] : []
}

/**
 * Checks a multipart body before it is read. A form post is a "simple" request that browsers
 * send from other sites without asking first, so it must come from a page that embeds Shuttle;
 * and its declared length, which HTTP framing holds it to, must be within the limit for
 * attachments.
 */
export function refuseMultipart(context: ApiContext): Response | null {
  const { request } = context

  if (
    request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data') !== true
  ) {
    return null
  }

  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')

  if (
    (site !== null && site !== 'same-origin' && site !== 'none') ||
    (origin !== null && !trustedOrigins(context).includes(origin))
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

/**
 * Makes the function that answers requests for the routes in `router`, or null for anything
 * else. A failure's reason is also under `error`, where older clients read it. A router whose
 * handlers want more than the engine's context is the caller's to give that context to.
 */
export function apiHandler(router: AnyRouter) {
  const handler = new OpenAPIHandler(router, {
    customErrorResponseBodyEncoder: (error) => ({ ...error.toJSON(), error: error.message }),
  })

  return async (context: ApiContext): Promise<Response | null> => {
    const refused = refuseMultipart(context)

    if (refused) {
      return refused
    }

    const { matched, response } = await handler.handle(context.request, { context })

    return matched ? response : null
  }
}

/** Answers a request for one of the engine's own routes, or null when it is for something else. */
export const handleApi = apiHandler(engineRouter)
