import { orgOfRun } from '@shuttle/api'

import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { isPublicSession } from '../tenancy/access'

/**
 * Whether lessons drawn from a session may go to its organization's playbook, which every member
 * reads. A lesson quotes what went wrong in the session, so one from a private session would
 * tell the organization about work only its owner and the people it is shared with may see.
 */
export async function mayShareLessons(env: EngineEnv, sessionRunId: string): Promise<boolean> {
  // A run with no organization has no playbook anyone else reads.
  if (orgOfRun(sessionRunId) === null) {
    return true
  }

  return isPublicSession(await loomsStub(env.LOOMS_RUN, sessionRunId).getAccess())
}
