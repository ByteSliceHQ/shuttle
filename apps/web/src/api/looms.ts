/**
 * Looms' own HTTP API, which the Worker forwards to a run. It is not part of Shuttle's contract:
 * a run's signals are defined by its Looms module, and what they do is read back from the run's
 * event stream, not from the response.
 */
export class SignalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Sends a named signal to a run. Looms takes a signal's input wrapped as `{ input }`.
 * `respond=async` has the run answer once the signal is on its log, since the page follows what
 * happens next on the event stream.
 */
export async function signalRun(runId: string, name: string, input: object): Promise<void> {
  const response = await fetch(`/runs/${encodeURIComponent(runId)}/signals/${name}?respond=async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300)

    throw new SignalError(
      detail || `The session refused the request (${response.status}).`,
      response.status,
    )
  }
}
