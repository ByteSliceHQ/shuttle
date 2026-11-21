import { admitSessionStart, resolveHost, SessionStartRefusedError } from '@shuttle/engine'
import type { Actor } from '@shuttle/engine/tenancy/access'

import type { ShuttleEnv } from '../env'
import { workerHost } from '../host'
import { forbidden } from './base'

/**
 * Asks the host's `sessionStart` port before a person's session begins, as the engine does for
 * the sessions it starts itself. A refusal reaches the person as the port's own reason.
 */
export async function admitPersonStart(
  env: ShuttleEnv,
  actor: Actor,
  repos: readonly { readonly fullName: string }[],
): Promise<void> {
  try {
    await admitSessionStart(resolveHost(workerHost(env)).ports.sessionStart, {
      kind: 'person',
      orgId: actor.orgId,
      acting: { kind: 'person', actor },
      repos: repos.map((repo) => repo.fullName),
    })
  } catch (cause) {
    throw cause instanceof SessionStartRefusedError ? forbidden(cause.reason) : cause
  }
}
