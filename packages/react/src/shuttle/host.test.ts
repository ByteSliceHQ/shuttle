import { describe, expect, test } from 'bun:test'

import type { JsonValue } from '@swirls/looms/core'

import { createShuttleHost, type ShuttleFetch } from './host'

interface Sent {
  readonly url: string
  readonly authorization: string | null
  readonly credentials: RequestCredentials | undefined
}

/** A backend that answers every request with `body`, and remembers what it was sent. */
function backend(body: JsonValue, status = 200) {
  const sent: Sent[] = []

  const fetch: ShuttleFetch = async (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      credentials: init?.credentials,
    })

    return Response.json(body, { status })
  }

  return { fetch, sent }
}

describe('createShuttleHost', () => {
  test("adds the host's headers to a request, asked for each time", async () => {
    const { fetch, sent } = backend({ modules: [] })
    let token = 'first'

    const host = createShuttleHost({
      baseUrl: 'https://engine.example',
      fetch,
      headers: () => ({ authorization: `Bearer ${token}` }),
    })

    await host.fetch('https://engine.example/a')
    token = 'second'
    await host.fetch('https://engine.example/b')

    expect(sent.map((request) => request.authorization)).toEqual(['Bearer first', 'Bearer second'])
    expect(host.headers()).toEqual({ authorization: 'Bearer second' })
  })

  test('says what the backend serves, asking once', async () => {
    const { fetch, sent } = backend({ modules: ['session', 'runs'], previews: false, grants: true })
    const host = createShuttleHost({ baseUrl: 'https://engine.example', fetch })

    expect(await host.capabilities()).toEqual({
      modules: ['session', 'runs'],
      previews: false,
      grants: true,
    })

    await host.capabilities()

    expect(sent.map((request) => request.url)).toEqual(['https://engine.example/capabilities'])
  })

  test('a backend that does not say what it serves answers null', async () => {
    const older = createShuttleHost({ baseUrl: 'https://engine.example', ...backend(null, 404) })
    const odd = createShuttleHost({ baseUrl: 'https://engine.example', ...backend({ ok: true }) })

    expect(await older.capabilities()).toBeNull()
    expect(await odd.capabilities()).toBeNull()
  })

  test("asks for a read grant for a run, and offers it to the run's store until it nears its end", async () => {
    const expiresAt = Date.now() + 10 * 60_000
    const { fetch, sent } = backend({ grant: 'v1.read.sig', expiresAt })
    const host = createShuttleHost({ baseUrl: 'https://engine.example', fetch, grants: true })
    const { grant } = host.runStoreOptions('ada')

    // Nothing is held the first time; asking is what fetches it.
    expect(grant?.('run_1')).toBeUndefined()
    await Bun.sleep(5)
    expect(grant?.('run_1')).toBe('v1.read.sig')
    expect(grant?.('run_1')).toBe('v1.read.sig')

    expect(sent.map((request) => request.url)).toEqual(['https://engine.example/runs/run_1/grant'])
  })

  test('a grant close to its end is renewed, and one past it is not offered', async () => {
    const { fetch, sent } = backend({ grant: 'v1.old.sig', expiresAt: Date.now() - 1 })
    const host = createShuttleHost({ baseUrl: 'https://engine.example', fetch, grants: true })
    const { grant } = host.runStoreOptions('ada')

    grant?.('run_1')
    await Bun.sleep(5)

    expect(grant?.('run_1')).toBeUndefined()
    await Bun.sleep(5)
    expect(sent).toHaveLength(2)
  })

  test('asks for no grants when told not to, and none for the empty run', async () => {
    const { fetch, sent } = backend({ grant: 'v1.read.sig', expiresAt: Date.now() + 600_000 })
    const off = createShuttleHost({ baseUrl: 'https://engine.example', fetch, grants: false })
    const on = createShuttleHost({ baseUrl: 'https://engine.example', fetch, grants: true })

    expect(off.runStoreOptions('ada').grant?.('run_1')).toBeUndefined()
    expect(on.runStoreOptions('ada').grant?.('')).toBeUndefined()
    await Bun.sleep(5)

    expect(sent).toEqual([])
  })

  test("a run's log is read with the host's headers", async () => {
    const { fetch, sent } = backend({ events: [] })

    const host = createShuttleHost({
      baseUrl: 'https://engine.example',
      fetch,
      grants: false,
      headers: () => ({ authorization: 'Bearer host' }),
    })

    await host.runStoreOptions('ada').fetch?.('https://engine.example/runs/run_1/events?fromSeq=1')

    expect(sent.map((request) => request.authorization)).toEqual(['Bearer host'])
  })
})
