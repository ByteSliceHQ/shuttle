import { playbookRunId, pullsRunId, workspaceRunId } from './config'
import type { EngineEnv } from './env'
import { loomsStub } from './looms-stub'

async function ensureNamedRun(
  env: EngineEnv,
  runId: string,
  launch: { kind: string; definitionName: string; input: { title: string } },
): Promise<void> {
  const stub = loomsStub(env.LOOMS_RUN, runId)

  try {
    // A signal can create the run's storage before launch, which `status()` reports as running.
    const run = await stub.getRun()

    if (run.startIdentity) {
      return
    }
  } catch {
    // continue to launch
  }

  try {
    await stub.launch(launch)
  } catch {
    // Another request may have created it.
  }
}

export async function ensurePlaybookQuietly(env: EngineEnv, orgId: string | null): Promise<void> {
  await ensureNamedRun(env, playbookRunId(env, orgId), {
    kind: 'reflect-playbook',
    definitionName: 'playbook',
    input: { title: 'Shuttle playbook' },
  })
}

/** Starts a workspace run if it has not started: an organization's, or a person's own. */
export async function ensureNamedWorkspace(env: EngineEnv, runId: string): Promise<void> {
  await ensureNamedRun(env, runId, {
    kind: 'shuttle-workspace',
    definitionName: 'workspace',
    input: { title: 'Shuttle workspace' },
  })
}

export async function ensureWorkspaceQuietly(env: EngineEnv, orgId: string | null): Promise<void> {
  await ensureNamedWorkspace(env, workspaceRunId(env, orgId))
}

export async function ensurePullsQuietly(env: EngineEnv, orgId: string | null): Promise<void> {
  await ensureNamedRun(env, pullsRunId(env, orgId), {
    kind: 'shuttle-pulls',
    definitionName: 'pulls',
    input: { title: 'Shuttle pulls' },
  })
}
