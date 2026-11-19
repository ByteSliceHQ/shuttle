import { providerIdForSandbox, type SandboxProviderId } from '../names'
import { cloudflareProvider } from './cloudflare'
import { daytonaProvider } from './daytona'
import { localProvider } from './local'
import { memoryProvider } from './memory'
import type { ProviderContext, SandboxMachine, SandboxProvider } from './types'

/** Every provider Shuttle can run a sandbox on. Adding one is a file beside this and a line here. */
const PROVIDERS: Readonly<Record<SandboxProviderId, SandboxProvider>> = {
  memory: memoryProvider,
  cloudflare: cloudflareProvider,
  daytona: daytonaProvider,
  local: localProvider,
}

export function sandboxProvider(id: SandboxProviderId): SandboxProvider {
  return PROVIDERS[id]
}

/** The sandbox a Durable Object stands for, on whichever provider its name and the deployment say. */
export function openSandbox(context: ProviderContext): SandboxMachine {
  return sandboxProvider(providerIdForSandbox(context.name, context.env)).open(context)
}
