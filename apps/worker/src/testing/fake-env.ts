import type { ShuttleEnv } from '../env'

function unavailable(binding: string) {
  return (): never => {
    throw new Error(`${binding} is not available in tests`)
  }
}

function fakeNamespace(binding: string) {
  const fail = unavailable(binding)

  return {
    newUniqueId: fail,
    idFromName: fail,
    idFromString: fail,
    get: fail,
    getByName: fail,
    jurisdiction: fail,
  }
}

/** A ShuttleEnv for unit tests. Its Durable Object bindings throw if a test reaches them. */
export function fakeEnv(overrides: Partial<ShuttleEnv> = {}): ShuttleEnv {
  return {
    LOOMS_RUN: fakeNamespace('LOOMS_RUN'),
    SANDBOX: fakeNamespace('SANDBOX'),
    EVENT_FIREHOSE: fakeNamespace('EVENT_FIREHOSE'),
    ...overrides,
  }
}
