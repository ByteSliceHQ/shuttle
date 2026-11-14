import { Schema } from 'effect'

import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
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
}

const memoryBindings = new Map<string, SandboxBinding>()

export function createBindSandboxEffect(env?: ShuttleEnv, storage?: DurableObjectStorage) {
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
      } satisfies SandboxBinding

      if (storage) {
        await storage.put(SANDBOX_BINDING_KEY, binding)
      } else {
        memoryBindings.set(ctx.runId, binding)
      }

      if (env && input.pull?.headSha) {
        const repo = input.repos.find((item) => item.fullName === input.pull?.fullName)

        if (repo) {
          const sandbox = sandboxStub(env, input.sandboxName)
          await sandbox.ensureRepos([repo])

          await sandbox.checkoutRef(ctx.runId, repo, {
            sha: input.pull.headSha,
            branch: `shuttle/review/${ctx.runId}/${repo.name}`,
          })
        }
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
