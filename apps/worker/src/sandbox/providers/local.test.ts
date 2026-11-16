import { describe, expect, test } from 'bun:test'

import type { RunnerInbound, RunnerOutbound } from '@shuttle/runner-protocol'

import { fakeEnv } from '../../testing/fake-env'
import { isSandboxOffline, localProvider } from './local'

// Workers has this; the test runtime does not.
Object.assign(globalThis, { WebSocketRequestResponsePair: function pair() {} })

/** A Durable Object with one hibernatable socket slot, and a runner that answers through it. */
function sandbox(answer: (frame: RunnerInbound, reply: (frame: RunnerOutbound) => void) => void) {
  const sockets: WebSocket[] = []

  const ctx = {
    setWebSocketAutoResponse: () => {},
    getWebSockets: () => sockets,
    storage: { get: async () => undefined, put: async () => {} },
  } as unknown as DurableObjectState

  const machine = localProvider.open({ ctx, env: fakeEnv({}), name: 'local:org:alice:laptop-1' })

  const connect = (at = 1) => {
    const socket = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ at }),
      send: (text: string) =>
        answer(JSON.parse(text) as RunnerInbound, (frame) => {
          void machine.webSocketMessage?.(socket as unknown as WebSocket, JSON.stringify(frame))
        }),
    }

    sockets.push(socket as unknown as WebSocket)

    return socket
  }

  return { machine, connect, sockets }
}

const b64 = (text: string) => Buffer.from(text).toString('base64')

describe("a sandbox on a person's machine", () => {
  test('runs a command through the runner and reports its pid before its output', async () => {
    const { machine, connect } = sandbox((frame, reply) => {
      if (frame.type === 'req' && frame.op === 'exec') {
        expect(frame.argv).toEqual(['echo', 'hi'])
        expect(frame.cwd).toBe('/workspace')
        expect(Buffer.from(frame.stdin ?? '', 'base64').toString()).toBe('input')
        reply({ type: 'started', id: frame.id, pid: 42 })

        reply({
          type: 'res',
          id: frame.id,
          ok: true,
          result: { stdout: b64('hi\n'), stderr: b64(''), exitCode: 0 },
        })
      }
    })

    connect()

    const process = await (
      await machine.host()
    ).exec(['echo', 'hi'], { cwd: '/workspace', stdin: new Blob(['input']).stream() })

    expect(process.pid).toBe(42)

    const output = await process.output()

    expect(new TextDecoder().decode(output.stdout)).toBe('hi\n')
    expect(output.exitCode).toBe(0)
  })

  test('reads and writes files as bytes, and says when one is missing', async () => {
    const files = new Map<string, string>()

    const { machine, connect } = sandbox((frame, reply) => {
      if (frame.type !== 'req') {
        return
      }

      if (frame.op === 'writeBytes') {
        files.set(frame.path, frame.data)
        reply({ type: 'res', id: frame.id, ok: true, result: {} })
      } else if (frame.op === 'readBytes') {
        const data = files.get(frame.path)

        reply(
          data === undefined
            ? { type: 'res', id: frame.id, ok: false, error: 'no such file', code: 'ENOENT' }
            : { type: 'res', id: frame.id, ok: true, result: { data } },
        )
      }
    })

    connect()

    const host = await machine.host()

    await host.writeFile('/workspace/a.txt', 'héllo')
    expect(await host.readFile('/workspace/a.txt')).toBe('héllo')
    expect(host.readFile('/workspace/missing')).rejects.toThrow(/^ENOENT/)
  })

  test('is offline, in a way callers can recognise, until a runner connects', async () => {
    const { machine, connect } = sandbox(() => {})

    expect(await machine.isAwake()).toBe(false)
    expect(isSandboxOffline(await machine.host().catch((cause: unknown) => cause))).toBe(true)

    connect()
    expect(await machine.isAwake()).toBe(true)
  })

  test('speaks to the newest open socket after a reconnect, not the one it replaced', async () => {
    const heard: number[] = []
    const { machine, connect, sockets } = sandbox(() => {})

    const old = connect(1)
    const current = connect(2)

    old.send = () => heard.push(1)
    current.send = () => heard.push(2)
    // Still listed while it finishes closing, and listed last.
    Object.assign(old, { readyState: WebSocket.CLOSING })
    sockets.reverse()

    void (await machine.host()).mkdir('/workspace/x').catch(() => {})

    expect(heard).toEqual([2])
  })

  test('fails what was waiting when the runner goes away', async () => {
    const { machine, connect } = sandbox(() => {})
    const socket = connect()
    const pending = (await machine.host()).mkdir('/workspace/x')

    Object.assign(socket, { readyState: WebSocket.CLOSED })
    await machine.webSocketClose?.(socket as unknown as WebSocket)

    expect(isSandboxOffline(await pending.catch((cause: unknown) => cause))).toBe(true)
  })
})
