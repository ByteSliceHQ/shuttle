import type { ShuttleEnv } from '../../env'
import type { SandboxHost } from '../host'
import type { SandboxProviderId } from '../names'
import type { Workspace } from '../workspace'

/**
 * A sandbox provider: one way of giving a session somewhere to work.
 *
 * `SessionSandbox` is the same Durable Object whatever a sandbox runs on. Everything that differs
 * (how the machine is started, how its files and processes are reached, how a terminal or a
 * preview gets to it) is behind this interface, so a new place to run sandboxes is one file here
 * and one line in `registry.ts`. Nothing outside this folder names a provider.
 *
 * A session moves between providers the same way it moves between two sandboxes of one provider:
 * its work is pushed to Code Storage from where it was and rebuilt where it is going (see
 * `session/handoff.ts`). A provider only has to offer a `SandboxHost` for that to work.
 */
export interface SandboxProvider {
  readonly id: SandboxProviderId
  /** `embedded` is inside the Durable Object itself; `local` is on a person's own machine. */
  readonly location: 'embedded' | 'cloud' | 'local'
  open(context: ProviderContext): SandboxMachine
}

export interface ProviderContext {
  readonly ctx: DurableObjectState
  readonly env: ShuttleEnv
  /** The sandbox's name, which is the Durable Object's. */
  readonly name: string
}

/** One sandbox, as its provider runs it. */
export interface SandboxMachine {
  /** `memory` has no machine behind it: no processes, terminal, previews or vendor agents. */
  readonly kind: 'memory' | 'container'
  workspace(): Promise<Workspace>
  /** The machine itself, started if it has to be. Rejects for a `memory` sandbox. */
  host(): Promise<SandboxHost>
  /** Whether it can be used right now without starting or waking anything. */
  isAwake(): Promise<boolean>
  /** Upgrades a request into a shell in the sandbox. */
  terminal(request: Request): Promise<Response>
  /** Forwards a request to a port in the sandbox. */
  preview(request: Request, port: number): Promise<Response>
  /** Requests only this provider understands. Null for any other. */
  fetch?(request: Request): Promise<Response | null>
  /** Hibernated WebSocket events, for a provider that accepts sockets on the Durable Object. */
  webSocketMessage?(socket: WebSocket, message: string | ArrayBuffer): Promise<void>
  webSocketClose?(socket: WebSocket): Promise<void>
  /** Ends a connection the machine holds to this sandbox, when it holds one. */
  disconnect?(): Promise<void>
  /** What is known about the machine, for showing to people. */
  describe?(): Promise<SandboxMachineInfo>
}

export interface SandboxMachineInfo {
  readonly online: boolean
  readonly device?: { readonly id: string; readonly name: string; readonly platform: string }
  readonly backend?: { readonly id: string; readonly label: string; readonly isolation: string }
}

export function containerModeRequired(): Response {
  return Response.json({ error: 'container-mode-required' }, { status: 501 })
}
