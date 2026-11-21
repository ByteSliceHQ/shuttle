import { z } from 'zod'

import { localRunName } from '@shuttle/api'

import { runNames, type RunNamesEnv } from '../tenancy/run-names'

export const RUN_KINDS = ['session', 'workspace', 'playbook', 'pulls'] as const

export const RunKindSchema = z.enum(RUN_KINDS)

export type RunKind = (typeof RUN_KINDS)[number]

export type RunKindEnv = RunNamesEnv

/**
 * Classify a Looms run id, whichever organization it belongs to. A person's own workspace run is
 * a workspace too.
 */
export function runKindFor(env: RunKindEnv, runId: string): RunKind {
  const local = localRunName(runId)
  const names = runNames(env)

  if (local === names.workspace) {
    return 'workspace'
  }

  if (local === names.playbook) {
    return 'playbook'
  }

  if (local === names.pulls) {
    return 'pulls'
  }

  return 'session'
}

/** Exhaustive switch helper so new run kinds fail at compile time. */
export function assertNeverRunKind(kind: never): never {
  throw new Error(`Unhandled run kind: ${String(kind)}`)
}
