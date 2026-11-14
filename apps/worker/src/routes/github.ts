import { ensurePullsQuietly, ensureWorkspaceQuietly } from '../bootstrap'
import { pullsRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos, signState, verifyState } from '../github/app'
import {
  exchangeGithubCode,
  githubAuthorizeUrl,
  githubOAuthConfigured,
  linkInstallations,
  listAccessibleInstallations,
} from '../github/user-link'
import { normalizeWebhook, verifyWebhookSignature } from '../github/webhooks'
import { loomsStub } from '../looms-stub'
import { ingestWebhook } from '../pulls/signals'
import type { Actor } from '../tenancy/access'
import { claimInstallation, orgsOfInstallation } from '../tenancy/installations'
import { isOrgId } from '../tenancy/run-id'
import { connectGithub } from '../workspace/module'

/**
 * Routes GitHub itself calls or sends the browser back to. They carry no sign-in: a webhook is
 * checked by its signature, and the setup and callback redirects by the signed state that names
 * the organization that started them.
 */
const INSTALL_STATE = 'install:'
const LINK_STATE = 'link:'

export async function handleGithubPublicRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/github/setup') {
    return finishSetup(url, env)
  }

  if (request.method === 'GET' && url.pathname === '/github/callback') {
    return finishLink(url, env)
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

  // Deliver the event to every organization the installation is connected to, and to no other.
  const orgIds = env.AUTH_DB ? await orgsOfInstallation(env.AUTH_DB, normalized.installationId) : []

  if (orgIds.length === 0) {
    return Response.json({ ok: true, ignored: 'installation is not connected' })
  }

  let signals: ReturnType<typeof ingestWebhook>[] = []

  switch (normalized.kind) {
    case 'pull.upserted':
      signals = [
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
      ]

      break
    case 'pull.closed':
      signals = [
        ingestWebhook({
          kind: 'pull.closed',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          number: normalized.number,
          updatedAt: normalized.updatedAt,
        }),
      ]

      break
    case 'review.submitted':
      signals = [
        ingestWebhook({
          kind: 'review.submitted',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          number: normalized.number,
          verdict: normalized.verdict,
          updatedAt: normalized.updatedAt,
        }),
      ]

      break
    case 'checks.updated':
      signals = [
        ingestWebhook({
          kind: 'checks.updated',
          deliveryId: normalized.deliveryId,
          installationId: normalized.installationId,
          fullName: normalized.fullName,
          headSha: normalized.headSha,
          checkRollup: normalized.checkRollup,
          updatedAt: normalized.updatedAt,
        }),
      ]

      break

    default: {
      const exhaustive: never = normalized
      void exhaustive
      break
    }
  }

  for (const orgId of orgIds) {
    await ensurePullsQuietly(env, orgId)
    await loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId)).signal(signals)
  }

  return Response.json({ ok: true })
}

/** How long a person has to get through GitHub and back. */
const LINK_STATE_TTL_MS = 15 * 60 * 1000

/** The GitHub page that installs the App, which comes back to `/github/setup`. */
async function installUrl(env: ShuttleEnv, orgId: string): Promise<string | null> {
  const slug = env.GITHUB_APP_SLUG

  if (!slug) {
    return null
  }

  const state = await signState(
    env,
    `${INSTALL_STATE}${orgId}:${crypto.randomUUID()}:${Date.now()}`,
  )

  const target = new URL(`https://github.com/apps/${slug}/installations/new`)

  target.searchParams.set('state', state)

  return target.toString()
}

/** The GitHub page that identifies the person, which comes back to `/github/callback`. */
async function authorizeUrl(env: ShuttleEnv, orgId: string): Promise<string> {
  return githubAuthorizeUrl(
    env,
    await signState(env, `${LINK_STATE}${orgId}:${crypto.randomUUID()}:${Date.now()}`),
  )
}

/**
 * Starts connecting GitHub. With the App's OAuth client configured the person first identifies
 * themselves, so installations they already have can be linked; without it, the only way in is
 * a fresh install.
 */
async function startInstall(env: ShuttleEnv, orgId: string): Promise<Response> {
  if (githubOAuthConfigured(env)) {
    return Response.redirect(await authorizeUrl(env, orgId), 302)
  }

  const target = await installUrl(env, orgId)

  return target
    ? Response.redirect(target, 302)
    : Response.json({ error: 'GITHUB_APP_SLUG is not configured' }, { status: 503 })
}

/**
 * GitHub sends the person back here once they have identified themselves. Every installation of
 * the App they can access, and that no other organization has, is linked to theirs.
 */
async function finishLink(url: URL, env: ShuttleEnv): Promise<Response> {
  const webUrl = env.SHUTTLE_WEB_URL ?? 'http://127.0.0.1:5180'
  const verified = await verifyState(env, url.searchParams.get('state') ?? '')
  const [kind, orgId, , issuedAt] = verified?.split(':') ?? []
  const code = url.searchParams.get('code')

  if (
    `${kind}:` !== LINK_STATE ||
    !isOrgId(orgId) ||
    !env.AUTH_DB ||
    !(Date.now() - Number(issuedAt) < LINK_STATE_TTL_MS)
  ) {
    return Response.redirect(`${webUrl}/?github=invalid_state`, 302)
  }

  // No code means the person declined on GitHub.
  if (!code) {
    return Response.redirect(`${webUrl}/?github=error`, 302)
  }

  try {
    const userToken = await exchangeGithubCode(env, code)

    const outcome = await linkInstallations(
      env.AUTH_DB,
      orgId,
      await listAccessibleInstallations(env, userToken),
    )

    if (outcome.kind === 'none') {
      // Nothing to link yet: send them to install the App, which comes back through setup.
      return Response.redirect((await installUrl(env, orgId)) ?? `${webUrl}/?github=error`, 302)
    }

    await ensureWorkspaceQuietly(env, orgId)

    await loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId)).signal(
      outcome.installations.map((installation) =>
        connectGithub({ installationId: installation.id, account: installation.account }),
      ),
    )

    return Response.redirect(`${webUrl}/?github=connected`, 302)
  } catch (error) {
    console.error('github link failed', error)

    return Response.redirect(`${webUrl}/?github=error`, 302)
  }
}

/**
 * GitHub sends the person here after installing the App, or after changing an installation.
 *
 * With the OAuth client configured, the installation id in the URL is not trusted: the person is
 * sent on to identify themselves, and only installations GitHub says they can access are linked.
 * A change to an existing installation arrives with no state at all, and is sent to start over
 * from the web app, where the person is signed in.
 */
async function finishSetup(url: URL, env: ShuttleEnv): Promise<Response> {
  const webUrl = env.SHUTTLE_WEB_URL ?? 'http://127.0.0.1:5180'
  const installationId = Number(url.searchParams.get('installation_id'))
  const state = url.searchParams.get('state') ?? ''
  const verified = await verifyState(env, state)
  const orgId = verified?.startsWith(INSTALL_STATE) ? verified.split(':')[1] : undefined

  if (githubOAuthConfigured(env)) {
    return Response.redirect(
      isOrgId(orgId) ? await authorizeUrl(env, orgId) : `${webUrl}/github/install`,
      302,
    )
  }

  if (!Number.isFinite(installationId) || installationId <= 0) {
    return Response.redirect(`${webUrl}/?github=missing_installation`, 302)
  }

  if (!isOrgId(orgId) || !env.AUTH_DB) {
    return Response.redirect(`${webUrl}/?github=invalid_state`, 302)
  }

  try {
    const installation = await getInstallation(env, installationId)

    if (!installation) {
      return Response.redirect(`${webUrl}/?github=not_found`, 302)
    }

    // Nothing here proves the person can access this installation, so it can only be taken
    // while no organization has it. With a client id and secret set, linking goes through
    // GitHub sign-in instead, and an installation can be connected to several organizations.
    if (!(await claimInstallation(env.AUTH_DB, installation.id, orgId))) {
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
