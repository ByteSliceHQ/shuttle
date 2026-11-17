import { type ShuttleHost, SignalError } from '@/shuttle'
import type { InterjectionKind } from '@shuttle/api'

/**
 * Sends a signal and, when the run refuses it, says what the person was trying to do ahead of
 * the run's own reason.
 */
async function signal(
  host: ShuttleHost,
  runId: string,
  name: string,
  input: object,
  failure: string,
): Promise<void> {
  try {
    await host.signalRun(runId, name, input)
  } catch (cause) {
    if (cause instanceof SignalError) {
      throw new SignalError(`${failure}: ${cause.message}`, cause.status)
    }

    throw cause
  }
}

/** Sends a message the session already has down a different route. */
export function reroute(
  host: ShuttleHost,
  runId: string,
  messageId: string,
  kind: InterjectionKind,
  targetThreadId?: string,
): Promise<void> {
  return signal(
    host,
    runId,
    'shuttle/reroute',
    { messageId, kind, ...(targetThreadId ? { targetThreadId } : {}) },
    'Failed to reroute',
  )
}

/** Resolves an agent's `ask_user` gate; `null` lets the agent use its own judgment. */
export function answerQuestion(
  host: ShuttleHost,
  runId: string,
  approvalId: string,
  answer: string | null,
): Promise<void> {
  const choice =
    answer === null
      ? { actionId: 'defer', outcome: 'reject' }
      : { actionId: 'answer', outcome: 'approve', payload: { answer } }

  return signal(host, runId, 'approval/decision', { approvalId, choice }, 'Failed to answer')
}

export function decideApproval(
  host: ShuttleHost,
  runId: string,
  approvalId: string,
  outcome: 'approve' | 'reject',
): Promise<void> {
  return signal(
    host,
    runId,
    'approval/decision',
    { approvalId, choice: outcome },
    'Failed to decide approval',
  )
}

/** Resolve a structured approval gate (PR publish / review submit). */
export function decideStructuredApproval(
  host: ShuttleHost,
  runId: string,
  approvalId: string,
  choice: {
    readonly actionId: string
    readonly outcome: 'approve' | 'reject'
    readonly payload?: Record<string, unknown>
  },
): Promise<void> {
  return signal(
    host,
    runId,
    'approval/decision',
    { approvalId, choice },
    'Failed to decide approval',
  )
}
