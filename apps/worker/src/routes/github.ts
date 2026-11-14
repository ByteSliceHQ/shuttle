import { ensurePullsQuietly, ensureWorkspaceQuietly } from '../bootstrap'
import { pullsRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos, signState, verifyState } from '../github/app'
import { normalizeWebhook, verifyWebhookSignature } from '../github/webhooks'
import { loomsStub } from '../looms-stub'
import { ingestWebhook } from '../pulls/signals'
import type { Actor } from '../tenancy/access'
import { bindInstallation, orgOfInstallation } from '../tenancy/installations'
import { isOrgId } from '../tenancy/run-id'
import { connectGithub } from '../workspace/module'

/**
 * Routes GitHub itself calls. They carry no sign-in: a webhook is checked by its signature, and
 * the setup redirect by the signed state that names the organization that started it.
 */
const INSTALL_STATE = 'install:'

export async function handleGithubPublicRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/github/setup') {
    return finishSetup(url, env)
  }

  if (request.method === 'POST' && url.pathname === '/github/webhooks') {
    return handleWebhook(request, env)
  }

  return null
}

export async function handleGithubRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/github/install') {
    return startInstall(env, actor.orgId)
  }

  if (request.method === 'GET' && url.pathname === '/github/repos') {
    return searchRepos(url, env, actor.orgId)
  }

  return null
}

async function handleWebhook(request: Request, env: ShuttleEnv): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('X-Hub-Signature-256')

  if (!(await verifyWebhookSignature(env, rawBody, signature))) {
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  const eventName = request.headers.get('X-GitHub-Event') ?? ''
  const deliveryId = request.headers.get('X-GitHub-Delivery') ?? crypto.randomUUID()
  let payload: unknown

  try {
    payload = JSON.parse(rawBody) as unknown
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  const normalized = normalizeWebhook(eventName, deliveryId, payload)

  if (normalized.kind === 'ignored') {
    return Response.json({ ok: true, ignored: normalized.reason })
  }

  // Deliver the event to the organization the installation is connected to, and to no other.
  const orgId = env.AUTH_DB ? await orgOfInstallation(env.AUTH_DB, normalized.installationId) : null

  if (!orgId) {
    return Response.json({ ok: true, ignored: 'installation is not connected' })
  }

  await ensurePullsQuietly(env, orgId)
  const stub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId))

  switch (normalized.kind) {
    case 'pull.upserted':
      await stub.signal([
        ingestWebhook({
          kind: 'pull.upserted',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          number: normalized.number,
          action: normalized.action,
          title: normalized.title,
          body: normalized.body,
          url: normalized.url,
          draft: normalized.draft,
          authorLogin: normalized.authorLogin,
          authorAvatarUrl: normalized.authorAvatarUrl,
          headRef: normalized.headRef,
          headSha: normalized.headSha,
          baseRef: normalized.baseRef,
          baseSha: normalized.baseSha,
          additions: normalized.additions,
          deletions: normalized.deletions,
          updatedAt: normalized.updatedAt,
          isFork: normalized.isFork,
          stack: normalized.stack,
        }),
      ])

      break
    case 'pull.closed':
      await stub.signal([
        ingestWebhook({
          kind: 'pull.closed',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          number: normalized.number,
          updatedAt: normalized.updatedAt,
        }),
      ])

      break
    case 'review.submitted':
      await stub.signal([
        ingestWebhook({
          kind: 'review.submitted',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          number: normalized.number,
          verdict: normalized.verdict,
          updatedAt: normalized.updatedAt,
        }),
      ])

      break
    case 'checks.updated':
      await stub.signal([
        ingestWebhook({
          kind: 'checks.updated',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          headSha: normalized.headSha,
          checkRollup: normalized.checkRollup,
          updatedAt: normalized.updatedAt,
        }),
      ])

      break

    default: {
      const exhaustive: never = normalized
      void exhaustive
      break
    }
  }

  return Response.json({ ok: true })
}

async function startInstall(env: ShuttleEnv, orgId: string): Promise<Response> {
  const slug = env.GITHUB_APP_SLUG

  if (!slug) {
    return Response.json({ error: 'GITHUB_APP_SLUG is not configured' }, { status: 503 })
  }

  const nonce = crypto.randomUUID()
  const state = await signState(env, `${INSTALL_STATE}${orgId}:${nonce}:${Date.now()}`)
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
  const orgId = verified?.startsWith(INSTALL_STATE) ? verified.split(':')[1] : undefined

  if (!isOrgId(orgId) || !env.AUTH_DB) {
    return Response.redirect(`${webUrl}/?github=invalid_state`, 302)
  }

  try {
    const installation = await getInstallation(env, installationId)

    if (!installation) {
      return Response.redirect(`${webUrl}/?github=not_found`, 302)
    }

    // An installation belongs to the first organization that connects it.
    if ((await bindInstallation(env.AUTH_DB, installation.id, orgId)) !== orgId) {
      return Response.redirect(`${webUrl}/?github=already_connected`, 302)
    }

    await ensureWorkspaceQuietly(env, orgId)
    const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))

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

async function searchRepos(url: URL, env: ShuttleEnv, orgId: string): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)

  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const tree = await readWorkspaceTree(env, orgId)

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

async function readWorkspaceTree(
  env: ShuttleEnv,
  orgId: string,
): Promise<{
  installations: Record<string, { installationId: number }>
}> {
  const runId = workspaceRunId(env, orgId)
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
