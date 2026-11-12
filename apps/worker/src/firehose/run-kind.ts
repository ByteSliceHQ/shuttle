export const RUN_KINDS = ['session', 'workspace', 'playbook', 'pulls'] as const

export type RunKind = (typeof RUN_KINDS)[number]

export interface RunKindEnv {
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_PULLS_RUN_ID?: string
}

/** Classify a Looms run id for the global firehose. */
export function runKindFor(env: RunKindEnv, runId: string): RunKind {
  if (runId === (env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace')) {
    return 'workspace'
  }

  if (runId === (env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook')) {
    return 'playbook'
  }

  if (runId === (env.SHUTTLE_PULLS_RUN_ID ?? 'shuttle-pulls')) {
    return 'pulls'
  }

  return 'session'
}

/** Exhaustive switch helper so new run kinds fail at compile time. */
export function assertNeverRunKind(kind: never): never {
  throw new Error(`Unhandled run kind: ${String(kind)}`)
}
