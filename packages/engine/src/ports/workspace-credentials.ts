import { workspaceRunId } from '../config'
import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { credentialKey, type CredentialPort } from './credentials'

/**
 * Shuttle's own behaviour: the sponsor's own sign-in, kept in the workspace run of the
 * organization. A turn nobody has asked for runs on nobody's.
 */
export function workspaceCredentials(env: EngineEnv): CredentialPort {
  const store = (orgId: string | null) => loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))

  return {
    ownerOf: ({ sponsorId }) => (sponsorId === null ? null : { kind: 'person', userId: sponsorId }),
    get: ({ owner, harness, orgId }) => store(orgId).getCredential(credentialKey(owner), harness),
    put: async ({ owner, harness, orgId }, payload) => {
      await store(orgId).putCredential(credentialKey(owner), harness, payload)
    },
  }
}
