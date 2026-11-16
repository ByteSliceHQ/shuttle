import { MemoryWorkspace } from '../memory-workspace'
import { containerModeRequired, type SandboxProvider } from './types'

/** A filesystem kept in the Durable Object. Needs no machine, and runs no processes. */
export const memoryProvider: SandboxProvider = {
  id: 'memory',
  location: 'embedded',
  open({ ctx, env }) {
    let workspace: MemoryWorkspace | null = null

    return {
      kind: 'memory',
      async workspace() {
        workspace ??= await MemoryWorkspace.restore(ctx.storage, env)
        workspace.resetAbort()

        return workspace
      },
      host: async () => {
        throw new Error('container-mode-required')
      },
      isAwake: async () => true,
      terminal: async () => containerModeRequired(),
      preview: async () => containerModeRequired(),
    }
  },
}
