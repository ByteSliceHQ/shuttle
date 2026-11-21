import { Schema } from 'effect'

import { orgOfRun } from '@shuttle/api'
import { localSandboxName, sandboxesArePersonal, userSandboxName } from '@shuttle/sandbox/names'

import type { EngineEnv } from '../env'
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
      const binding: SandboxBinding =
        input.pull === undefined
          ? { sandboxName: input.sandboxName, repos: input.repos }
          : { sandboxName: input.sandboxName, repos: input.repos, pull: input.pull }

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

/** True for a string that is neither missing nor empty. */
function isPresent(value: string | null): value is string {
  return value !== null && value !== ''
}

export async function readSandboxBinding(
  storage: DurableObjectStorage | undefined,
  runId?: string,
): Promise<SandboxBinding | null> {
  if (storage) {
    const value = await storage.get<SandboxBinding>(SANDBOX_BINDING_KEY)
    return value ?? null
  }

  if (runId !== undefined && runId !== '') {
    return memoryBindings.get(runId) ?? null
  }

  return null
}

export const SANDBOX_PLACEMENT_KEY = 'shuttle:sandbox-placement'

/**
 * Where a person asked for a session to run, when that is one of their own machines. A session
 * with no placement runs in the cloud, on the deployment's provider.
 */
export interface SandboxPlacement {
  readonly kind: 'local'
  /** Whose machine it is. */
  readonly userId: string
  readonly deviceId: string
}

type PlacementStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>

export async function readSandboxPlacement(
  storage: Pick<DurableObjectStorage, 'get'>,
): Promise<SandboxPlacement | null> {
  return (await storage.get<SandboxPlacement>(SANDBOX_PLACEMENT_KEY)) ?? null
}

export async function writeSandboxPlacement(
  storage: PlacementStorage,
  placement: SandboxPlacement | null,
): Promise<void> {
  if (placement) {
    await storage.put(SANDBOX_PLACEMENT_KEY, placement)
  } else {
    await storage.delete(SANDBOX_PLACEMENT_KEY)
  }
}

/**
 * The sandbox a session's work runs in right now.
 *
 * A session placed on a person's own machine runs there for as long as it is working for that
 * person. When someone else gives it work, that turn runs in the cloud instead: a machine only
 * ever runs its owner's turns, on its owner's sign-ins. The session's work follows it either way
 * (see `handoff.ts`).
 *
 * On Daytona each person has a sandbox of their own, and a session runs in the one that belongs
 * to whoever it is working for (see `sponsor.ts`), so that person's sign-ins are the only ones
 * near the work. Elsewhere a session runs in the sandbox it was bound to: its folder's.
 */
export async function sandboxNameForSession(
  env: Pick<EngineEnv, 'SHUTTLE_WORKSPACE_MODE'>,
  storage: DurableObjectStorage | undefined,
  runId: string,
  boundName: string,
): Promise<string> {
  if (!storage) {
    return boundName
  }

  const orgId = orgOfRun(runId)
  const sponsorId = await readSponsor(storage)
  const placement = await readSandboxPlacement(storage)

  if (
    placement !== null &&
    isPresent(orgId) &&
    (sponsorId === null || sponsorId === placement.userId)
  ) {
    return localSandboxName(orgId, placement.userId, placement.deviceId)
  }

  if (!sandboxesArePersonal(env)) {
    return boundName
  }

  return isPresent(orgId) && isPresent(sponsorId) ? userSandboxName(orgId, sponsorId) : boundName
}
