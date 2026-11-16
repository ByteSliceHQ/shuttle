/**
 * What the page last read from the Worker, kept so a view that has shown something once can show
 * it again at once. A read always asks the Worker again; the kept value only fills the wait.
 *
 * Reads of the same thing that overlap share one request.
 */
interface Entry {
  value?: unknown
  loading?: Promise<unknown>
}

const entries = new Map<string, Entry>()

/** Reads through the cache: one request per key at a time, and the answer is kept. */
export function cachedFetch<T>(key: string, load: () => Promise<T>): Promise<T> {
  const entry = entries.get(key) ?? {}
  entries.set(key, entry)

  if (entry.loading) {
    // SAFETY: a key is only ever read with one loader, so its values share a type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return entry.loading as Promise<T>
  }

  const loading = load().then(
    (value) => {
      // A write or an invalidation since this read started wins over what the read brings back.
      if (entry.loading === loading) {
        entry.value = value
        entry.loading = undefined
      }

      return value
    },
    (cause: unknown) => {
      if (entry.loading === loading) {
        entry.loading = undefined
      }

      throw cause
    },
  )

  entry.loading = loading

  return loading
}

/** The value last read or written for `key`, if there is one. Never waits. */
export function peekCached<T>(key: string): T | undefined {
  // SAFETY: a key is only ever read with one loader, so its values share a type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return entries.get(key)?.value as T | undefined
}

/** Records what a write left behind, so the next view shows it without asking. */
export function putCached<T>(key: string, value: T): T {
  entries.set(key, { value })

  return value
}

/** Forgets a request in flight, so the next read asks again. The kept value stays to show. */
export function invalidateCached(key: string): void {
  const entry = entries.get(key)

  if (entry) {
    entry.loading = undefined
  }
}

/** Forgets everything, as when someone signs out. */
export function clearCached(): void {
  entries.clear()
}
