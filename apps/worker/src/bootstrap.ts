import { playbookRunId, workspaceRunId } from './config'
import type { ShuttleEnv } from './env'
import { loomsStub } from './looms-stub'

async function ensureNamedRun(
  env: ShuttleEnv,
  runId: string,
  launch: { kind: string; definitionName: string; input: { title: string } },
): Promise<void> {
  const stub = loomsStub(env.LOOMS_RUN, runId)

  try {
    const status = await stub.status()

    if (status) {
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

export async function ensurePlaybookQuietly(env: ShuttleEnv): Promise<void> {
  await ensureNamedRun(env, playbookRunId(env), {
    kind: 'reflect-playbook',
    definitionName: 'playbook',
    input: { title: 'Shuttle playbook' },
  })
}

export async function ensureWorkspaceQuietly(env: ShuttleEnv): Promise<void> {
  await ensureNamedRun(env, workspaceRunId(env), {
    kind: 'shuttle-workspace',
    definitionName: 'workspace',
    input: { title: 'Shuttle workspace' },
  })
}
