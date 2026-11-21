import { authAllowedAs, authDenied, type AuthDecision, type RouteInfo } from '@swirls/looms/runtime'

import type { EngineEnv } from '../env'
import { runKindFor, type RunKind } from '../firehose/run-kind'
import { loomsStub } from '../looms-stub'
import { canOpenSession, type Actor } from '../tenancy/access'
import { parsePersonalRunId, parseRunId, sessionOfReflection } from '../tenancy/run-id'

/**
 * Decides whether a signed-in person may reach a run. Every request that names a run passes
 * through here before it touches the run's Durable Object.
 *
 * A run in another organization, another person's own run, and a session the person may not
 * open all answer 404: the caller learns nothing about whether it exists.
 */

const notFound = () => Response.json({ error: 'Not found' }, { status: 404 })

const TAB_SIGNALS = [
  'workspace/openTab',
  'workspace/closeTab',
  'workspace/reorderTabs',
  'workspace/retargetTab',
]

/**
 * Signals a browser may send straight to a run. Everything else that changes a run goes through
 * a Worker route, which checks the request and records who made it.
 */
const BROWSER_SIGNALS: Record<RunKind, readonly string[]> = {
  // A message goes through `POST /sessions/:id/say`, which records who sent it.
  session: ['shuttle/reroute', 'approval/decision'],
  workspace: [
    'workspace/createFolder',
    'workspace/renameFolder',
    'workspace/archiveFolder',
    'workspace/reorderFolders',
    'workspace/setFolderAutoReview',
    ...TAB_SIGNALS,
  ],
  playbook: [],
  pulls: [],
}

/** A personal workspace lists sessions and their tabs. Folders belong to the organization. */
const PERSONAL_WORKSPACE_SIGNALS: readonly string[] = TAB_SIGNALS

function browserSignals(env: EngineEnv, runId: string): readonly string[] {
  return parsePersonalRunId(runId)
    ? PERSONAL_WORKSPACE_SIGNALS
    : BROWSER_SIGNALS[runKindFor(env, runId)]
}

/** The run a request path is about: `/runs/<id>/…` or `/sessions/<id>/…`. */
export function runIdOfPath(pathname: string): string | null {
  const match = /^\/(?:runs|sessions)\/([^/]+)/.exec(pathname)

  if (match?.[1] === undefined || match[1] === '') {
    return null
  }

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** Null when `actor` may reach `runId`; otherwise the response to send instead. */
export async function authorizeRun(
  env: EngineEnv,
  actor: Actor,
  runId: string,
): Promise<Response | null> {
  if (parseRunId(runId).orgId !== actor.orgId) {
    return notFound()
  }

  // A personal run is its person's alone, whatever kind of run it is.
  const personal = parsePersonalRunId(runId)

  if (personal) {
    return personal.userId === actor.userId ? null : notFound()
  }

  if (runKindFor(env, runId) !== 'session') {
    return null
  }

  // A reflection run is part of the session it reflects on.
  const access = await loomsStub(env.LOOMS_RUN, sessionOfReflection(runId)).getAccess()

  return canOpenSession(access, actor) ? null : notFound()
}

/**
 * Decides a request to one of Looms' own routes, after `authorizeRun` has passed for the run it
 * names. Reads are allowed. The only writes allowed are the signals listed above. Either way the
 * request is recorded as `actor`'s, so the events it sends carry their id.
 */
export function authorizeLoomsRoute(env: EngineEnv, actor: Actor, route: RouteInfo): AuthDecision {
  if (route.access === 'read') {
    return authAllowedAs(actor.userId)
  }

  if (
    route.access === 'write' &&
    route.runId !== undefined &&
    route.signal !== undefined &&
    browserSignals(env, route.runId).includes(route.signal)
  ) {
    return authAllowedAs(actor.userId)
  }

  return authDenied(403, 'This change is not allowed from the browser')
}
