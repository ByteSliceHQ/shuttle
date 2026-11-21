import { DEFAULT_RUN_NAMES, type RunNames } from '@shuttle/api'

/** The names this deployment gives an organization's own runs. */
export function runNames(env: RunNamesEnv): RunNames {
  return {
    workspace: env.SHUTTLE_WORKSPACE_RUN_ID ?? DEFAULT_RUN_NAMES.workspace,
    playbook: env.SHUTTLE_PLAYBOOK_RUN_ID ?? DEFAULT_RUN_NAMES.playbook,
    pulls: env.SHUTTLE_PULLS_RUN_ID ?? DEFAULT_RUN_NAMES.pulls,
  }
}

export interface RunNamesEnv {
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_PULLS_RUN_ID?: string
}
