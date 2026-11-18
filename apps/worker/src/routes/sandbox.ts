import { resolveSandboxName } from '../api/sandbox'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import {
  isLocalSandbox,
  sandboxesArePersonal,
  userOfSandbox,
  userSandboxName,
} from '../sandbox/names'
import type { Actor } from '../tenancy/access'

/**
 * A session's terminal, which is a WebSocket and so not part of the API contract. Everything
 * else under `/sessions/<id>/sandbox/` is in `api/sandbox.ts`.
 *
 * `index.ts` has already checked that `actor` may open the session the path names.
 */
export async function handleSandboxRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/sandbox\/terminal$/)

  if (!match) {
    return null
  }

  const runId = decodeURIComponent(match[1] ?? '')

  if (!runId) {
    return Response.json({ error: 'Invalid sandbox path' }, { status: 400 })
  }

  // A terminal is a shell with its owner's sign-ins in reach, so where sandboxes are personal it
  // opens in the viewer's own, never in the one the session happens to be working in.
  const own = sandboxesArePersonal(env) ? userSandboxName(actor.orgId, actor.userId) : null

  // Starts in the session's files when this sandbox has them; the sandbox falls back if not.
  if (!url.searchParams.get('cwd')) {
    url.searchParams.set('cwd', `/workspace/.wt/${runId}`)
  }

  const home = await resolveSandboxName(env, runId)

  // A session on the viewer's own machine opens there: that sandbox is theirs too.
  const mine = isLocalSandbox(home) && userOfSandbox(home) === actor.userId

  return forwardTerminal(
    new Request(url, request),
    sandboxStub(env, mine ? home : (own ?? home)),
    env,
  )
}

async function forwardTerminal(
  request: Request,
  stub: ReturnType<typeof sandboxStub>,
  env: ShuttleEnv,
): Promise<Response> {
  const mode = await stub.getMode().catch(() => ({ mode: 'memory' as const }))

  if (mode.mode !== 'container' && env.SHUTTLE_WORKSPACE_MODE !== 'container') {
    return Response.json({ error: 'container-mode-required' }, { status: 501 })
  }

  return stub.fetch(request)
}
