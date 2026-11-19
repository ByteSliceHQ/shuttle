import type { JsonValue } from '@swirls/looms/core'

/** The part of Durable Object storage that Shuttle's key-value helpers read and write. */
type KeyValueStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/**
 * Durable Object storage for unit tests, held in a map. `initial` is what the storage already
 * holds. `values` shows what has been written, for tests that check the stored form.
 */
export function memoryStorage(
  initial: readonly (readonly [string, JsonValue])[] = [],
): KeyValueStorage & {
  readonly values: ReadonlyMap<string, unknown>
} {
  const values = new Map<string, unknown>(initial)

  const storage = {
    values,
    get: async (key: string) => values.get(key),
    put: async (key: string, value: JsonValue) => {
      values.set(key, value)
    },
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: the fake answers get and put by key, the only storage calls these helpers make; the real `get` is generic in the stored type, which a map cannot know.
  return storage as unknown as KeyValueStorage & { readonly values: ReadonlyMap<string, unknown> }
}
