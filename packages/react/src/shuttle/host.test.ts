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
})
