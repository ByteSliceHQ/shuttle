import { Effect } from 'effect'

import { routeToDurableObject } from '@swirls/looms/cloudflare'
import { authAllowedAs, authDenied, runGrantToken, verifyRunGrant } from '@swirls/looms/runtime'

import { shuttleModules } from '../modules'
import { authorizeLoomsRoute, runIdOfPath } from './gate'
import { portableApiModules, type ApiModule } from './serve'

/**
 * A run's own log: reading it, live, and the signals a browser may send it. Every other module
 * shows what this one streams, so a host that mounts any of them mounts this. It forwards to the
 * run's Durable Object, which is why it loads only in a Worker.
 */
export const runsApi: ApiModule = {
  name: 'runs',
  claims: (pathname) => /^\/runs(?:\/|$)/.test(pathname),

  handle: async ({ request, env, actor }, host) => {
    // Looms' routes that name no run (listing and launching them) are not a browser's to call.
    if (runIdOfPath(new URL(request.url).pathname) === null) {
      return null
    }

    // Looms says which of its routes a request is for; only reads and the signals a browser may
    // send get through, each recorded as this person's.
    return routeToDurableObject(env.LOOMS_RUN, request, {
      // Listing definitions does not need a session's own sandbox.
      modules: () => shuttleModules(host, 'definitions'),
      authorize: (_request, route) => authorizeLoomsRoute(env, actor, route),
    })
  },

  // A grant reads the one run it names, as the person it was given to, and nothing else.
  handleGranted: async (request, host, secret) =>
    routeToDurableObject(host.env.LOOMS_RUN, request, {
      modules: () => shuttleModules(host, 'definitions'),
      authorize: (granted, route) =>
        Effect.runPromise(
          verifyRunGrant(secret, runGrantToken(granted) ?? '', Date.now()).pipe(
            Effect.map((grant) =>
              route.access === 'read' && route.runId === grant.runId
                ? authAllowedAs(grant.principal)
                : authDenied(403, 'Forbidden'),
            ),
            Effect.catchTag('GrantError', () => Effect.succeed(authDenied(401, 'Unauthorized'))),
          ),
        ),
    }),
}

/** Every module, in the order a request is offered to them. */
export const shuttleApiModules: readonly ApiModule[] = [...portableApiModules, runsApi]
