import { isTerminalBridgeEvent, type BridgeEvent } from '../../bridge/protocol'
import { workspaceRunId } from '../config'
import { CredentialsKeyMissingError } from '../credentials/store'
import { sandboxStub, type ShuttleEnv } from '../env'
import { isVendorHarness, parseHarness, type VendorHarnessId } from '../harness'
import { loomsStub } from '../looms-stub'
import { CONNECTABLE_HARNESSES, vendorHarnessInfo } from '../vendor/harnesses'

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
 *   PUT    /workspace/connections/default                         harness for new sessions
 */

/** Sign-ins run in their own sandbox, apart from any folder's workspace. */
const CONNECTIONS_SANDBOX = 'connections'
const LOGIN_ID = /^[A-Za-z0-9_-]{1,80}$/

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

export async function handleConnectionRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (!url.pathname.startsWith('/workspace/connections')) {
    return null
  }

  try {
    return await route(request, env, url)
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

async function route(request: Request, env: ShuttleEnv, url: URL): Promise<Response> {
  const credentials = loomsStub(env.LOOMS_RUN, workspaceRunId(env))
  const sandbox = sandboxStub(env, CONNECTIONS_SANDBOX)
  const parts = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)

  if (parts.length === 0) {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const connected = new Map(
      (await credentials.listCredentials()).map((entry) => [entry.harness, entry.updatedAt]),
    )

    return json({
      defaultHarness: (await credentials.getHarness()).harness,
      mode: (await sandbox.getMode()).mode,
      canStore: Boolean(env.SHUTTLE_CREDENTIALS_KEY?.trim()),
      connections: CONNECTABLE_HARNESSES.map((harness) => ({
        harness,
        label: vendorHarnessInfo(harness).label,
        connected: connected.has(harness),
        updatedAt: connected.get(harness) ?? null,
      })),
    })
  }

  if (parts.length === 1 && parts[0] === 'default') {
    if (request.method !== 'PUT') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const body = (await request.json().catch(() => null)) as { harness?: unknown } | null
    const preferred = parseHarness(body?.harness)

    if (!preferred) {
      return json({ error: 'unknown harness' }, 400)
    }

    // New sessions start on this harness. It is stored on the workspace run.
    return json({ defaultHarness: (await credentials.setHarness(preferred)).harness })
  }

  const harness = parseHarness(parts[0])

  if (!harness || !isVendorHarness(harness) || !vendorHarnessInfo(harness).supported) {
    return json({ error: 'unknown harness' }, 404)
  }

  if (parts.length === 1) {
    if (request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405)
    }

    return json({ removed: await credentials.removeCredential(harness) })
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

async function followLogin(
  harness: VendorHarnessId,
  loginId: string,
  offset: number,
  deps: {
    sandbox: ReturnType<typeof sandboxStub>
    credentials: ReturnType<typeof loomsStub>
  },
): Promise<Response> {
  const page = await deps.sandbox.readAgentEvents(
    loginId,
    Number.isFinite(offset) && offset > 0 ? offset : 0,
  )

  const end = page.events.find(isTerminalBridgeEvent) as
    | Extract<BridgeEvent, { type: 'login_done' }>
    | undefined

  if (!end?.success) {
    return json({ ...page, connected: false })
  }

  // The CLI is signed in inside this container only. Store its sign-in files so sessions, which
  // run in other containers, can use them.
  const { files } = await deps.sandbox.collectAgentFiles(vendorHarnessInfo(harness).credentialFiles)

  if (Object.keys(files).length === 0) {
    return json({
      ...page,
      connected: false,
      error: `${vendorHarnessInfo(harness).label} reported success but left no sign-in files to store.`,
    })
  }

  await deps.credentials.putCredential(harness, { files })

  return json({ ...page, connected: true })
}
