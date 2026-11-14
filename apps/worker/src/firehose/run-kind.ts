import { localRunName } from '../tenancy/run-id'

export const RUN_KINDS = ['session', 'workspace', 'playbook', 'pulls'] as const

export type RunKind = (typeof RUN_KINDS)[number]

export interface RunKindEnv {
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_PULLS_RUN_ID?: string
}

/**
 * Classify a Looms run id, whichever organization it belongs to. A person's own workspace run is
 * a workspace too.
 */
export function runKindFor(env: RunKindEnv, runId: string): RunKind {
  const local = localRunName(runId)

  if (local === (env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace')) {
    return 'workspace'
  }

  if (local === (env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook')) {
    return 'playbook'
  }

  if (local === (env.SHUTTLE_PULLS_RUN_ID ?? 'shuttle-pulls')) {
    return 'pulls'
  }

  return 'session'
}

/** Exhaustive switch helper so new run kinds fail at compile time. */
export function assertNeverRunKind(kind: never): never {
  throw new Error(`Unhandled run kind: ${String(kind)}`)
}
