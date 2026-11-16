import { describe, expect, test } from 'bun:test'

import { fakeEnv } from '../testing/fake-env'
import { ContainerWorkspace } from './container-workspace'
import type { HostOutput, SandboxHost } from './host'

describe('a workspace on a host', () => {
  test('is busy for exactly as long as a command is running', async () => {
    const { promise: finished, resolve: finish } = Promise.withResolvers<HostOutput>()

    const host = {
      exec: async () => ({ output: () => finished }),
    } as unknown as SandboxHost

    const workspace = new ContainerWorkspace(async () => host, fakeEnv({}))

    expect(workspace.busy()).toBe(false)

    const running = workspace.exec('sleep 30')

    // Let the command reach the host.
    await Promise.resolve()
    await Promise.resolve()
    expect(workspace.busy()).toBe(true)

    finish({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 })
    await running
    expect(workspace.busy()).toBe(false)
  })
})
