import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { loomsStub } from '../looms-stub'

const MAX_FILE_BYTES = 512_000

/** `index.ts` has already checked that `actor` may open the session the path names. */
export async function handleSandboxRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  const match = url.pathname.match(/^\/sessions\/([^/]+)\/sandbox\/(files|file|diff|terminal)$/)

  if (!match) {
    return null
  }

  const runId = decodeURIComponent(match[1] ?? '')
  const action = match[2]

  if (!runId || !action) {
    return Response.json({ error: 'Invalid sandbox path' }, { status: 400 })
  }

  const sandboxName = await resolveSandboxName(env, runId)
  const stub = sandboxStub(env, sandboxName)

  switch (action) {
    case 'files': {
      if (request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 })
      }

      return listFiles(stub, runId)
    }

    case 'file': {
      if (request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 })
      }

      return readFile(stub, runId, url.searchParams.get('path'))
    }

    case 'diff': {
      if (request.method !== 'GET') {
        return Response.json({ error: 'Method not allowed' }, { status: 405 })
      }

      return listDiffs(stub, runId)
    }

    case 'terminal':
      return forwardTerminal(request, stub, env)

    default: {
      const exhaustive: never = action as never

      return exhaustive
    }
  }
}

/**
 * The sandbox a session runs in, as the session itself recorded it when it bound one. Nothing in
 * the request chooses it, so a caller cannot name a sandbox it has no session in. A session that
 * has not bound a sandbox yet has nothing to show, and gets an empty one named after itself.
 */
async function resolveSandboxName(env: ShuttleEnv, runId: string): Promise<string> {
  return (await loomsStub(env.LOOMS_RUN, runId).getSandboxName()) ?? runId
}

async function listFiles(stub: ReturnType<typeof sandboxStub>, runId: string): Promise<Response> {
  const sessionRoot = `/workspace/.wt/${runId}`

  try {
    const mode = await stub.getMode()
    const { files } = await stub.listFiles(sessionRoot)

    const relative = files
      .map((path) =>
        path.startsWith(`${sessionRoot}/`) ? path.slice(sessionRoot.length + 1) : path,
      )
      .filter((path) => path.length > 0 && !path.includes('\0'))

    const entries = relative.map((path) => ({ path, kind: 'file' as const }))

    return Response.json({
      root: sessionRoot,
      files: entries,
      mode: mode.mode,
    })
  } catch (cause) {
    return Response.json(
      {
        root: sessionRoot,
        files: [],
        error: cause instanceof Error ? cause.message : String(cause),
      },
      { status: 500 },
    )
  }
}

async function readFile(
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
  pathParam: string | null,
): Promise<Response> {
  if (!pathParam) {
    return Response.json({ error: 'path is required' }, { status: 400 })
  }

  const sessionRoot = `/workspace/.wt/${runId}`

  const absolute = pathParam.startsWith('/')
    ? pathParam
    : `${sessionRoot}/${pathParam.replace(/^\.\//, '')}`

  if (!absolute.startsWith(`${sessionRoot}/`) && absolute !== sessionRoot) {
    return Response.json({ error: 'path escapes session worktree' }, { status: 400 })
  }

  try {
    const result = await stub.readFile(absolute)

    if (result.missing) {
      return Response.json({ path: absolute, error: result.error }, { status: 404 })
    }

    const binary = looksBinary(result.content.slice(0, 4096))
    const truncated = result.content.length > MAX_FILE_BYTES

    return Response.json({
      path: absolute,
      content: truncated ? result.content.slice(0, MAX_FILE_BYTES) : result.content,
      binary,
      truncated,
    })
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 404 },
    )
  }
}

async function listDiffs(stub: ReturnType<typeof sandboxStub>, runId: string): Promise<Response> {
  const sessionRoot = `/workspace/.wt/${runId}`

  try {
    const { files } = await stub.listFiles(sessionRoot)
    const repoRoots = new Set<string>()

    for (const path of files) {
      // `/workspace/.wt/<runId>/<repo>/...`
      const match = path.match(new RegExp(`^${escapeRegExp(sessionRoot)}/([^/]+)`))

      if (match?.[1]) {
        repoRoots.add(`${sessionRoot}/${match[1]}`)
      }
    }

    const diffs = []

    for (const cwd of [...repoRoots].toSorted()) {
      const { diff } = await stub.gitDiff(cwd)
      const name = cwd.split('/').pop() ?? cwd

      if (diff.trim()) {
        diffs.push({ cwd, name, diff })
      }
    }

    return Response.json({ diffs })
  } catch (cause) {
    return Response.json(
      { diffs: [], error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}

async function forwardTerminal(
  request: Request,
  stub: ReturnType<typeof sandboxStub>,
  env: ShuttleEnv,
): Promise<Response> {
  const mode = await stub.getMode().catch(() => ({ mode: 'memory' as const }))

  if (mode.mode !== 'container' && env.SHUTTLE_WORKSPACE_MODE !== 'container') {
    return Response.json({ error: 'container-mode-required' }, { status: 501 })
  }

  return stub.fetch(request)
}

function looksBinary(sample: string): boolean {
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)

    if (code === 0) {
      return true
    }

    // C0 controls except tab / LF / CR.
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true
    }
  }

  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
