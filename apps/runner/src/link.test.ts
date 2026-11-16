import { afterEach, describe, expect, test } from 'bun:test'

import type { RunnerInbound, RunnerOutbound } from '@shuttle/runner-protocol'
import { RUNNER_REMOVED } from '@shuttle/runner-protocol'

import { MissingFileError, type LocalBackend } from './backend'
import { connect } from './link'

/** A stand-in for Shuttle: accepts the runner's socket and lets a test speak on it. */
function shuttle() {
  const frames: RunnerOutbound[] = []
  const waiting: ((frame: RunnerOutbound) => void)[] = []
  let authorization = ''
  let socket: { send(text: string): void; close(code: number, reason: string): void } | null = null

  const server = Bun.serve({
    port: 0,
    fetch(request, self) {
      authorization = request.headers.get('authorization') ?? ''

      return self.upgrade(request) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        socket = ws
      },
      message(_ws, message) {
        if (typeof message !== 'string' || !message.startsWith('{')) {
          return
        }

        const frame = JSON.parse(message) as RunnerOutbound
        const next = waiting.shift()

        if (next) {
          next(frame)
        } else {
          frames.push(frame)
        }
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    authorization: () => authorization,
    next: () =>
      new Promise<RunnerOutbound>((resolve) => {
        const ready = frames.shift()

        if (ready) {
          resolve(ready)
        } else {
          waiting.push(resolve)
        }
      }),
    send: (frame: RunnerInbound) => socket?.send(JSON.stringify(frame)),
    close: (code: number) => socket?.close(code, 'bye'),
    stop: () => server.stop(true),
  }
}

const backend = {
  info: { id: 'fake', label: 'Fake', isolation: 'container' },
  exec: async (argv: readonly string[], options: { started?: (pid: number) => void }) => {
    options.started?.(7)

    return {
      stdout: new TextEncoder().encode(argv.join(' ')),
      stderr: new Uint8Array(),
      exitCode: 0,
    }
  },
  readBytes: async (path: string) => {
    throw new MissingFileError(path)
  },
} as unknown as LocalBackend

const device = { id: 'laptop-1', name: 'Laptop', platform: 'darwin', arch: 'arm64' }
const open: { stop(): void }[] = []

afterEach(() => {
  for (const item of open.splice(0)) {
    item.stop()
  }
})

describe('the runner link', () => {
  test('signs in with the machine token, says hello, and answers requests', async () => {
    const server = shuttle()

    const link = connect({
      url: server.url,
      token: 'shr_x',
      device,
      backend,
      status: () => {},
      removed: () => {},
    })

    open.push(server, { stop: () => link.close() })

    expect(await server.next()).toMatchObject({ type: 'hello', device, backend: { id: 'fake' } })
    expect(server.authorization()).toBe('Bearer shr_x')

    server.send({ type: 'req', id: 'a', op: 'exec', argv: ['echo', 'hi'] })

    expect(await server.next()).toEqual({ type: 'started', id: 'a', pid: 7 })

    expect(await server.next()).toEqual({
      type: 'res',
      id: 'a',
      ok: true,
      result: { stdout: Buffer.from('echo hi').toString('base64'), stderr: '', exitCode: 0 },
    })

    server.send({ type: 'req', id: 'b', op: 'readBytes', path: '/nope' })

    expect(await server.next()).toMatchObject({ type: 'res', id: 'b', ok: false, code: 'ENOENT' })
  })

  test('stops for good when the machine is removed from Shuttle', async () => {
    const server = shuttle()
    const { promise: removed, resolve } = Promise.withResolvers<boolean>()
    const statuses: string[] = []

    const link = connect({
      url: server.url,
      token: 'shr_x',
      device,
      backend,
      status: (status) => statuses.push(status),
      removed: () => resolve(true),
    })

    open.push(server, { stop: () => link.close() })

    await server.next()
    server.close(RUNNER_REMOVED)

    expect(await removed).toBe(true)
    // It does not go back to connecting.
    expect(statuses.at(-1)).toBe('online')
  })
})
