/** The message a promise rejects with. Fails when it resolves, so tests can assert on the reason. */
export async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  throw new Error('expected the promise to reject, but it resolved')
}
