import { ensureContainerRunning, reapplyInactivityTimeout } from '../container-runtime'
import { ContainerWorkspace } from '../container-workspace'
import { cloudflareHost } from '../host'
import { orgOfSandbox } from '../names'
import { proxyContainerPreview } from '../preview-proxy'
import { openContainerTerminal } from '../terminal'
import { containerModeRequired, type SandboxProvider } from './types'

/** The Durable Object's own container. */
export const cloudflareProvider: SandboxProvider = {
  id: 'cloudflare',
  location: 'cloud',
  open({ ctx, env, name }) {
    reapplyInactivityTimeout(ctx)

    const host = async () => cloudflareHost(await ensureContainerRunning(ctx.container))
    let workspace: ContainerWorkspace | null = null

    return {
      kind: 'container',
      host,
      workspace: async () => (workspace ??= new ContainerWorkspace(host, env, orgOfSandbox(name))),
      isAwake: async () => true,
      terminal: async (request) =>
        ctx.container ? openContainerTerminal(request, ctx.container) : containerModeRequired(),
      preview: async (request, port) =>
        ctx.container
          ? proxyContainerPreview(request, ctx.container, port)
          : containerModeRequired(),
    }
  },
}
