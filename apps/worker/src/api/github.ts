import { z } from 'zod'

import { ensureWorkspaceQuietly } from '@shuttle/engine/bootstrap'
import { workspaceRunId } from '@shuttle/engine/config'
import { loomsStub } from '@shuttle/engine/looms-stub'
import { listInstallationRepos } from '@shuttle/git/github/app'

import type { ShuttleEnv } from '../env'
import { api } from './base'

/** The part of the workspace tree projection that names the connected installations. */
const InstallationsProjection = z.object({
  value: z
    .object({
      installations: z.record(z.string(), z.object({ installationId: z.number() })).optional(),
    })
    .optional(),
})

/** The ids of the GitHub App installations connected to an organization. */
async function connectedInstallationIds(env: ShuttleEnv, orgId: string): Promise<number[]> {
  const runId = workspaceRunId(env, orgId)

  const response = await loomsStub(env.LOOMS_RUN, runId).fetch(
    new Request(`https://shuttle.internal/runs/${runId}/projections/workspaceTree`),
  )

  if (!response.ok) {
    return []
  }

  const body = InstallationsProjection.safeParse(await response.json())

  return Object.values(body.data?.value?.installations ?? {}).map(
    (installation) => installation.installationId,
  )
}

export const githubRouter = {
  repos: api.github.repos.handler(async ({ input, context: { env, actor } }) => {
    await ensureWorkspaceQuietly(env, actor.orgId)

    const query = (input.q ?? '').trim().toLowerCase()
    const installationIds = await connectedInstallationIds(env, actor.orgId)

    if (installationIds.length === 0) {
      return { repos: [], note: 'No GitHub App installations connected.' }
    }

    const repos = (
      await Promise.all(installationIds.map((id) => listInstallationRepos(env, id)))
    ).flat()

    const filtered =
      query !== ''
        ? repos.filter(
            (repo) =>
              repo.fullName.toLowerCase().includes(query) ||
              repo.name.toLowerCase().includes(query) ||
              repo.owner.toLowerCase().includes(query),
          )
        : repos

    return {
      repos: filtered.slice(0, 50).map((repo) => ({
        installationId: repo.installationId,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
      })),
    }
  }),
}
