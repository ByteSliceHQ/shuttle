import { afterEach, describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { RunnerInbound, RunnerOutbound } from '@shuttle/runner-protocol'
import { RUNNER_REMOVED } from '@shuttle/runner-protocol'

import {
  MissingFileError,
  type ExecOutput,
  type LocalBackend,
  type LocalTerminal,
  type SandboxHttpResponse,
} from './backend'
import { connect } from './link'

/** The frames the runner sends, as a test reads them off the wire. */
const outboundSchema: z.ZodType<RunnerOutbound> = z.union([
  z.object({
    type: z.literal('hello'),
    protocol: z.number(),
    device: z.object({
      id: z.string(),
      name: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    backend: z.object({
      id: z.string(),
      label: z.string(),
      isolation: z.enum(['microvm', 'vm', 'container', 'process']),
      version: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('started'), id: z.string(), pid: z.number() }),
  z.object({ type: z.literal('res'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    type: z.literal('res'),
    id: z.string(),
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  }),
  z.object({ type: z.literal('term.data'), term: z.string(), data: z.string() }),
  z.object({ type: z.literal('term.exit'), term: z.string() }),
])

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
        const text = z.string().safeParse(message)

        if (!text.success || !text.data.startsWith('{')) {
          return
        }

        const frame = outboundSchema.parse(JSON.parse(text.data))
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

/** A backend that echoes what it is asked to run and has no files. */
class FakeBackend implements LocalBackend {
  readonly info = { id: 'fake', label: 'Fake', isolation: 'container' } as const

  ensure(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): Promise<void> {
    return Promise.resolve()
  }

  exec(
    argv: readonly string[],
    options: { readonly started?: (pid: number) => void },
  ): Promise<ExecOutput> {
    options.started?.(7)

    return Promise.resolve({
      stdout: new TextEncoder().encode(argv.join(' ')),
      stderr: new Uint8Array(),
      exitCode: 0,
    })
  }

  readBytes(path: string): Promise<Uint8Array> {
    return Promise.reject(new MissingFileError(path))
  }

  writeBytes(): Promise<void> {
    return Promise.resolve()
  }

  mkdir(): Promise<void> {
    return Promise.resolve()
  }

  http(): Promise<SandboxHttpResponse> {
    return Promise.reject(new Error('not used'))
  }

  openTerminal(): Promise<LocalTerminal> {
    return Promise.reject(new Error('not used'))
  }
}

const backend = new FakeBackend()

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
