import { DEVICE_ID } from '@shuttle/runner-protocol'

import { isTerminalBridgeEvent, type BridgeEvent } from '../../bridge/protocol'
import { workspaceRunId } from '../config'
import { CredentialsKeyMissingError } from '../credentials/store'
import { sandboxStub, type ShuttleEnv } from '../env'
import { isVendorHarness, parseHarness, type VendorHarnessId } from '../harness'
import { loomsStub } from '../looms-stub'
import { shellQuote } from '../sandbox/exec-argv'
import {
  isLocalSandbox,
  localSandboxName,
  sandboxesArePersonal,
  sandboxIsPersonal,
  userSandboxName,
} from '../sandbox/names'
import { parseTeam } from '../team'
import type { Actor } from '../tenancy/access'
import { CONNECTABLE_HARNESSES, signInFilesPresent, vendorHarnessInfo } from '../vendor/harnesses'

export { signInFilesPresent }
import {
  builtInVendorModels,
  CATALOGUE_TTL_MS,
  listsOwnModels,
  parseVendorModels,
  type VendorModel,
} from '../vendor/models'

/**
 * Connecting a coding agent subscription. Sign-in is always the vendor CLI's own flow, run in a
 * sandbox container: Shuttle shows the link or code the CLI prints and passes back what the CLI
 * asks for. Once the CLI reports success its sign-in files are stored, encrypted, so sessions can
 * place them in their own containers.
 *
 *   GET    /workspace/connections
 *   POST   /workspace/connections/:harness/login                  start sign-in
 *   GET    /workspace/connections/:harness/login/:id?offset=N     follow it
 *   POST   /workspace/connections/:harness/login/:id/code         pass a code back
 *   POST   /workspace/connections/:harness/login/:id/cancel
 *   DELETE /workspace/connections/:harness                        disconnect
 *   GET    /workspace/connections/:harness/models                 models the agent offers
 *   PUT    /workspace/connections/default                         harness for new sessions
 */

/** The header the desktop app sends to say "on this machine", with the machine's id. */
const DEVICE_HEADER = 'x-shuttle-device'

/** Sign-ins run in a sandbox of the person's own, apart from any folder's workspace. */
function connectionsSandbox(env: ShuttleEnv, actor: Actor, request: Request): string {
  const deviceId = request.headers.get(DEVICE_HEADER)

  // Asked from the desktop app, a sign-in happens on that machine and stays there: a session
  // working there uses it, and it never leaves for the cloud. The name is built from the
  // caller, so the machine is one of their own.
  if (deviceId && DEVICE_ID.test(deviceId)) {
    return localSandboxName(actor.orgId, actor.userId, deviceId)
  }

  // Where each person has a sandbox of their own, they sign in there, where their sessions run.
  return sandboxesArePersonal(env)
    ? userSandboxName(actor.orgId, actor.userId)
    : `connections:${actor.userId}`
}

const LOGIN_ID = /^[A-Za-z0-9_-]{1,80}$/

/** Why a sign-in process that stopped without a word did, in terms someone can act on. */
export function explainDeadRun(label: string, log: string): string {
  if (log.includes('Cannot find module') && log.includes('shuttle-bridge')) {
    return (
      `${label} sign-in could not start: this sandbox has no agent bridge. It was created from an ` +
      'image without one. Delete the sandbox in Daytona so it is recreated from the agent image ' +
      '(DAYTONA_SNAPSHOT), then try again.'
    )
  }

  const lastLine = log
    .trim()
    .split('\n')
    .findLast((line) => line.trim() !== '')

  return lastLine
    ? `${label} sign-in stopped before it started: ${lastLine.trim().slice(0, 300)}`
    : `${label} sign-in stopped before it started, and left no explanation.`
}

/** A command that deletes the sign-in files. */
export function removeSignInFiles(homeRelativePaths: readonly string[]): string {
  return homeRelativePaths.length === 0
    ? 'true'
    : `rm -f ${homeRelativePaths.map((path) => `"$HOME"/${shellQuote(path)}`).join(' ')}`
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export async function handleConnectionRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/workspace/connections')) {
    return null
  }

  try {
    return await route(request, env, url, actor)
  } catch (cause) {
    if (cause instanceof CredentialsKeyMissingError) {
      return json({ error: cause.message }, 503)
    }

    const message = cause instanceof Error ? cause.message : String(cause)

    if (message.includes('container-mode-required')) {
      return json(
        { error: 'Connecting a subscription needs SHUTTLE_WORKSPACE_MODE=container.' },
        501,
      )
    }

    return json({ error: message }, 500)
  }
}

async function route(request: Request, env: ShuttleEnv, url: URL, actor: Actor): Promise<Response> {
  const { userId } = actor
  const credentials = loomsStub(env.LOOMS_RUN, workspaceRunId(env, actor.orgId))
  const sandboxName = connectionsSandbox(env, actor, request)
  const sandbox = sandboxStub(env, sandboxName)
  // Whether sign-ins are kept in this sandbox and nowhere else.
  const personal = sandboxIsPersonal(sandboxName, env)
  const parts = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)

  if (parts.length === 0) {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405)
    }

    // Signed in in the cloud: recorded on the workspace run.
    const inCloud = new Map(
      (await credentials.listCredentials(userId)).map((entry) => [entry.harness, entry.updatedAt]),
    )

    // Asked from the desktop app, also on this machine. There the sign-in is a file in the
    // machine's sandbox and nowhere else, so that is what is asked. A machine whose sandbox is
    // not running has none that can be used.
    const onMachine = isLocalSandbox(sandboxName)
      ? new Set(
          (
            await Promise.all(
              CONNECTABLE_HARNESSES.map(async (harness) =>
                (
                  await sandbox
                    .exec(signInFilesPresent(vendorHarnessInfo(harness).credentialFiles))
                    .catch(() => ({ exitCode: 1 }))
                ).exitCode === 0
                  ? harness
                  : null,
              ),
            )
          ).filter((harness) => harness !== null),
        )
      : null

    return json({
      machine: onMachine !== null,
      defaultHarness: (await credentials.getHarness()).harness,
      defaultTeam: (await credentials.getTeam()).team,
      mode: (await sandbox.getMode()).mode,
      canStore: Boolean(env.SHUTTLE_CREDENTIALS_KEY?.trim()),
      connections: CONNECTABLE_HARNESSES.map((harness) => {
        const cloud = inCloud.has(harness)
        const local = onMachine ? onMachine.has(harness) : null

        return {
          harness,
          label: vendorHarnessInfo(harness).label,
          // Signed in somewhere: the agent can be picked, and runs where it is signed in.
          connected: cloud || local === true,
          cloud,
          local,
          updatedAt: inCloud.get(harness) ?? null,
        }
      }),
    })
  }

  if (parts.length === 1 && parts[0] === 'default') {
    if (request.method !== 'PUT') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const body = (await request.json().catch(() => null)) as {
      harness?: unknown
      team?: unknown
    } | null

    const preferred = body?.harness === undefined ? undefined : parseHarness(body.harness)
    const team = body?.team === undefined ? undefined : parseTeam(body.team)

    if (preferred === null || team === null || (!preferred && !team)) {
      return json({ error: 'unknown harness or invalid team' }, 400)
    }

    // New sessions start with these. They are stored on the workspace run.
    return json({
      defaultHarness: preferred
        ? (await credentials.setHarness(preferred)).harness
        : (await credentials.getHarness()).harness,
      defaultTeam: team
        ? (await credentials.setTeam(team)).team
        : (await credentials.getTeam()).team,
    })
  }

  const harness = parseHarness(parts[0])

  if (!harness || !isVendorHarness(harness) || !vendorHarnessInfo(harness).supported) {
    return json({ error: 'unknown harness' }, 404)
  }

  if (parts.length === 1) {
    if (request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405)
    }

    // Where the sign-in lives in the person's sandbox, disconnecting deletes it there.
    if (personal) {
      await sandbox
        .exec(removeSignInFiles(vendorHarnessInfo(harness).credentialFiles))
        .catch(() => {})
    }

    // A machine's sign-in was never recorded in the cloud, so the cloud one stays.
    if (isLocalSandbox(sandboxName)) {
      return json({ removed: true })
    }

    return json({ removed: await credentials.removeCredential(userId, harness) })
  }

  if (parts.length === 2 && parts[1] === 'models') {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405)
    }

    return json({ harness, models: await vendorModels(harness, { sandbox, credentials }) })
  }

  if (parts[1] !== 'login') {
    return json({ error: 'Not found' }, 404)
  }

  if (parts.length === 2) {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    if (!env.SHUTTLE_CREDENTIALS_KEY?.trim()) {
      throw new CredentialsKeyMissingError()
    }

    const loginId = `login_${harness.replaceAll(/[^a-z0-9]/g, '-')}_${crypto.randomUUID()}`

    await sandbox.startAgentRun({ runKey: loginId, mode: 'login', request: { harness } })

    return json({ loginId })
  }

  const loginId = parts[2] ?? ''

  if (!LOGIN_ID.test(loginId)) {
    return json({ error: 'Invalid sign-in id' }, 400)
  }

  if (parts.length === 3 && request.method === 'GET') {
    return followLogin(harness, loginId, Number(url.searchParams.get('offset') ?? 0), {
      sandbox,
      credentials,
      userId,
      keepInSandbox: personal,
      onMachine: isLocalSandbox(sandboxName),
    })
  }

  if (parts.length === 4 && request.method === 'POST' && parts[3] === 'code') {
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code.trim() : ''

    if (!code) {
      return json({ error: 'code is required' }, 400)
    }

    await sandbox.sendAgentInput(loginId, code)

    return json({ ok: true })
  }

  if (parts.length === 4 && request.method === 'POST' && parts[3] === 'cancel') {
    await sandbox.stopAgentRun(loginId)

    return json({ ok: true })
  }

  return json({ error: 'Not found' }, 404)
}

/**
 * The models to offer for an agent. An agent that can list its own is asked at most once a day,
 * in the sign-in sandbox; the built-in list covers every case where it cannot be asked.
 */
async function vendorModels(
  harness: VendorHarnessId,
  deps: {
    sandbox: ReturnType<typeof sandboxStub>
    credentials: ReturnType<typeof loomsStub>
  },
): Promise<readonly VendorModel[]> {
  if (!listsOwnModels(harness)) {
    return builtInVendorModels(harness)
  }

  const cached = await deps.credentials.getVendorCatalogue(harness)

  if (cached && Date.now() - cached.fetchedAt < CATALOGUE_TTL_MS) {
    return cached.models
  }

  try {
    const listed = parseVendorModels(await deps.sandbox.listAgentModels(harness))

    if (listed.length > 0) {
      return (await deps.credentials.putVendorCatalogue(harness, listed)).models
    }
  } catch {
    // No container, or a sandbox image from before the bridge could list models.
  }

  return cached?.models ?? builtInVendorModels(harness)
}

/** Daytona (and some containers) can report the bridge gone before its event file is visible. */
async function readLoginAftermath(
  loginId: string,
  offset: number,
  sandbox: ReturnType<typeof sandboxStub>,
): Promise<{ page: Awaited<ReturnType<typeof sandbox.readAgentEvents>>; log: string }> {
  let page = await sandbox.readAgentEvents(loginId, offset)
  let log = ''

  for (let attempt = 0; attempt < 5 && page.events.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    page = await sandbox.readAgentEvents(loginId, offset)
    log = (await sandbox.readAgentLog(loginId).catch(() => ({ log: '' }))).log

    if (page.events.length > 0 || log.trim()) {
      break
    }
  }

  if (!log.trim()) {
    log = (await sandbox.readAgentLog(loginId).catch(() => ({ log: '' }))).log
  }

  return { page, log }
}

async function followLogin(
  harness: VendorHarnessId,
  loginId: string,
  offset: number,
  deps: {
    sandbox: ReturnType<typeof sandboxStub>
    credentials: ReturnType<typeof loomsStub>
    userId: string
    /** True where the sandbox is the person's own and the sign-in stays on its disk. */
    keepInSandbox: boolean
    /** True where that sandbox is on one of the person's machines. */
    onMachine: boolean
  },
): Promise<Response> {
  const startOffset = Number.isFinite(offset) && offset > 0 ? offset : 0
  let page = await deps.sandbox.readAgentEvents(loginId, startOffset)

  let end = page.events.find(isTerminalBridgeEvent) as
    | Extract<BridgeEvent, { type: 'login_done' }>
    | undefined

  // A bridge that fails immediately can exit before the sandbox filesystem shows its events.
  // Wait briefly so we surface the real login_done error instead of an empty log.
  if (!end && page.events.length === 0) {
    const { state } = await deps.sandbox.agentRunState(loginId)

    if (state === 'exited' || state === 'missing') {
      const aftermath = await readLoginAftermath(loginId, startOffset, deps.sandbox)
      page = aftermath.page

      end = page.events.find(isTerminalBridgeEvent) as
        | Extract<BridgeEvent, { type: 'login_done' }>
        | undefined

      if (!end) {
        return json({
          ...page,
          done: true,
          connected: false,
          error: explainDeadRun(vendorHarnessInfo(harness).label, aftermath.log),
        })
      }
    }
  }

  if (!end?.success) {
    return json({ ...page, connected: false })
  }

  const info = vendorHarnessInfo(harness)

  if (deps.keepInSandbox) {
    // The sandbox is this person's own and keeps the sign-in on its disk. Shuttle only checks
    // that it is there, without reading it, and records that the agent is connected.
    const present = await deps.sandbox.exec(signInFilesPresent(info.credentialFiles))

    if (present.exitCode !== 0) {
      return json({
        ...page,
        connected: false,
        error: `${info.label} reported success but left no sign-in in the sandbox.`,
      })
    }

    // Recorded only for the cloud. A machine's sign-in is found by looking on the machine, and
    // recording it here would show the agent as signed in in the cloud as well.
    if (!deps.onMachine) {
      await deps.credentials.putCredential(deps.userId, harness, {})
    }

    return json({ ...page, connected: true })
  }

  // The CLI is signed in inside this container only. Store its sign-in files so sessions, which
  // run in other containers, can use them.
  const { files } = await deps.sandbox.collectAgentFiles(info.credentialFiles)

  if (Object.keys(files).length === 0) {
    return json({
      ...page,
      connected: false,
      error: `${info.label} reported success but left no sign-in files to store.`,
    })
  }

  await deps.credentials.putCredential(deps.userId, harness, { files })

  return json({ ...page, connected: true })
}
