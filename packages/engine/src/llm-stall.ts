/**
 * Ends a model call whose reply has stopped arriving.
 *
 * A streamed reply normally sends something every few seconds. When a provider stops sending
 * without closing the connection, the call would otherwise wait forever, and the agent's turn
 * with it: the session shows "working" and nothing ever happens. This aborts the call once it
 * has been silent for too long, so the turn fails and can be retried or reported.
 */

/** How long a reply may go without sending anything before it is given up on. */
export const MODEL_STALL_MS = 180_000

export class ModelStalledError extends Error {
  constructor(silentMs: number) {
    super(
      `The model stopped responding: nothing arrived for ${Math.round(silentMs / 1000)} seconds.`,
    )

    this.name = 'ModelStalledError'
  }
}

export interface StallGuard {
  /** Give this to the model call in place of the caller's signal. */
  readonly signal: AbortSignal
  /** Call whenever part of the reply arrives. */
  readonly touch: () => void
  /** Call when the reply is over, however it ended. */
  readonly done: () => void
  /** Whether the guard is what aborted the call. */
  readonly stalled: () => boolean
}

/**
 * Watches one model call. It aborts when `silentMs` pass without `touch`, and also when the
 * caller's own signal aborts, so cancelling still works.
 */
export function stallGuard(outer: AbortSignal | undefined, silentMs = MODEL_STALL_MS): StallGuard {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stalled = false

  const arm = () => {
    clearTimeout(timer)

    timer = setTimeout(() => {
      stalled = true
      controller.abort(new ModelStalledError(silentMs))
    }, silentMs)
  }

  const onOuterAbort = () => {
    clearTimeout(timer)
    controller.abort(outer?.reason)
  }

  if (outer?.aborted === true) {
    onOuterAbort()
  } else {
    outer?.addEventListener('abort', onOuterAbort, { once: true })
    arm()
  }

  return {
    signal: controller.signal,
    touch: () => {
      if (!controller.signal.aborted) {
        arm()
      }
    },
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
    stalled: () => stalled,
  }
}
