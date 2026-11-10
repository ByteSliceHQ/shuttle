import { ensureWorkspaceQuietly } from '../bootstrap'
import { workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos, signState, verifyState } from '../github/app'
import { loomsStub } from '../looms-stub'
import { connectGithub } from '../workspace/module'

export async function handleGithubRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/github/install') {
    return startInstall(env)
  }

  if (request.method === 'GET' && url.pathname === '/github/setup') {
    return finishSetup(url, env)
  }

  if (request.method === 'GET' && url.pathname === '/github/repos') {
    return searchRepos(url, env)
  }

  return null
}

async function startInstall(env: ShuttleEnv): Promise<Response> {
  const slug = env.GITHUB_APP_SLUG

  if (!slug) {
    return Response.json({ error: 'GITHUB_APP_SLUG is not configured' }, { status: 503 })
  }

  const nonce = crypto.randomUUID()
  const state = await signState(env, `install:${nonce}:${Date.now()}`)
  const target = new URL(`https://github.com/apps/${slug}/installations/new`)
  target.searchParams.set('state', state)

  return Response.redirect(target.toString(), 302)
}

async function finishSetup(url: URL, env: ShuttleEnv): Promise<Response> {
  const webUrl = env.SHUTTLE_WEB_URL ?? 'http://127.0.0.1:5180'
  const installationId = Number(url.searchParams.get('installation_id'))
  const state = url.searchParams.get('state') ?? ''

  if (!Number.isFinite(installationId) || installationId <= 0) {
    return Response.redirect(`${webUrl}/?github=missing_installation`, 302)
  }

  const verified = await verifyState(env, state)

  if (!verified?.startsWith('install:')) {
    return Response.redirect(`${webUrl}/?github=invalid_state`, 302)
  }

  try {
    const installation = await getInstallation(env, installationId)

    if (!installation) {
      return Response.redirect(`${webUrl}/?github=not_found`, 302)
    }

    await ensureWorkspaceQuietly(env)
    const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env))

    await stub.signal([
      connectGithub({
        installationId: installation.id,
        account: installation.account,
      }),
    ])

    return Response.redirect(`${webUrl}/?github=connected`, 302)
  } catch (error) {
    console.error('github setup failed', error)
    return Response.redirect(`${webUrl}/?github=error`, 302)
  }
}

async function searchRepos(url: URL, env: ShuttleEnv): Promise<Response> {
  await ensureWorkspaceQuietly(env)

  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const tree = await readWorkspaceTree(env)

  const installationIds = Object.values(tree.installations).map(
    (installation) => installation.installationId,
  )

  if (installationIds.length === 0) {
    return Response.json({ repos: [], note: 'No GitHub App installations connected.' })
  }

  const repos = (
    await Promise.all(installationIds.map((id) => listInstallationRepos(env, id)))
  ).flat()

  const filtered = query
    ? repos.filter(
        (repo) =>
          repo.fullName.toLowerCase().includes(query) ||
          repo.name.toLowerCase().includes(query) ||
          repo.owner.toLowerCase().includes(query),
      )
    : repos

  return Response.json({
    repos: filtered.slice(0, 50).map((repo) => ({
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
    })),
  })
}

async function readWorkspaceTree(env: ShuttleEnv): Promise<{
  installations: Record<string, { installationId: number }>
}> {
  const runId = workspaceRunId(env)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const request = new Request(`https://shuttle.internal/runs/${runId}/projections/workspaceTree`, {
    method: 'GET',
  })

  const response = await stub.fetch(request)

  if (!response.ok) {
    return { installations: {} }
  }

  const body = (await response.json()) as {
    value?: { installations?: Record<string, { installationId: number }> }
  }

  return { installations: body.value?.installations ?? {} }
}
