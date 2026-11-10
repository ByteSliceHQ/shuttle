import { Schema } from 'effect'

import { shuttleModule } from './scope'

const LinkedRepoSchema = Schema.Struct({
  installationId: Schema.Finite,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
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

export function createBindSandboxEffect(storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.bindSandbox',
    placement: 'local',
    input: Schema.Struct({
      sandboxName: Schema.String,
      repos: Schema.Array(LinkedRepoSchema),
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

      await ctx.emit(
        shuttleModule.input('sandbox.bound', {
          sandboxName: input.sandboxName,
          repoCount: input.repos.length,
        }),
      )

      return []
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
