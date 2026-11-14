import { Schema } from 'effect'

import type { ShuttleEnv } from '../env'
import { sandboxesArePersonal, userSandboxName } from '../sandbox/names'
import { orgOfRun } from '../tenancy/run-id'
import { shuttleModule } from './scope'
import { readSponsor } from './sponsor'

const LinkedRepoSchema = Schema.Struct({
  installationId: Schema.Finite,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
})

const PullRefSchema = Schema.Struct({
  fullName: Schema.String,
  number: Schema.Finite,
  headSha: Schema.String,
  baseSha: Schema.String,
})

export const SANDBOX_BINDING_KEY = 'shuttle:sandbox-binding'

export interface SandboxBinding {
  readonly sandboxName: string
  readonly repos: readonly {
    readonly installationId: number
    readonly owner: string
    readonly name: string
    readonly fullName: string
    readonly defaultBranch: string
    readonly private: boolean
  }[]
  /**
   * The pull request a review session reads. Its head is checked out as the session's worktree
   * when the session's sandbox is prepared (see `handoff.ts`), in whichever sandbox that is.
   */
  readonly pull?: {
    readonly fullName: string
    readonly number: number
    readonly headSha: string
    readonly baseSha: string
  }
}

const memoryBindings = new Map<string, SandboxBinding>()

export function createBindSandboxEffect(storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.bindSandbox',
    placement: 'local',
    input: Schema.Struct({
      sandboxName: Schema.String,
      repos: Schema.Array(LinkedRepoSchema),
      pull: Schema.optional(PullRefSchema),
    }),
    execute: async (input, ctx) => {
      const binding = {
        sandboxName: input.sandboxName,
        repos: input.repos,
        ...(input.pull ? { pull: input.pull } : {}),
      } satisfies SandboxBinding

      if (storage) {
        await storage.put(SANDBOX_BINDING_KEY, binding)
      } else {
        memoryBindings.set(ctx.runId, binding)
      }

      return [
        shuttleModule.input('sandbox.bound', {
          sandboxName: input.sandboxName,
          repoCount: input.repos.length,
        }),
      ]
    },
  })
}

export async function readSandboxBinding(
  storage: DurableObjectStorage | undefined,
  runId?: string,
): Promise<SandboxBinding | null> {
  if (storage) {
    const value = await storage.get<SandboxBinding>(SANDBOX_BINDING_KEY)
    return value ?? null
  }

  if (runId) {
    return memoryBindings.get(runId) ?? null
  }

  return null
}

/**
 * The sandbox a session's work runs in right now.
 *
 * On Daytona each person has a sandbox of their own, and a session runs in the one that belongs
 * to whoever it is working for (see `sponsor.ts`), so that person's sign-ins are the only ones
 * near the work. Elsewhere a session runs in the sandbox it was bound to: its folder's.
 */
export async function sandboxNameForSession(
  env: Pick<ShuttleEnv, 'SHUTTLE_WORKSPACE_MODE'>,
  storage: DurableObjectStorage | undefined,
  runId: string,
  boundName: string,
): Promise<string> {
  if (!sandboxesArePersonal(env) || !storage) {
    return boundName
  }

  const orgId = orgOfRun(runId)
  const sponsorId = await readSponsor(storage)

  return orgId && sponsorId ? userSandboxName(orgId, sponsorId) : boundName
}
