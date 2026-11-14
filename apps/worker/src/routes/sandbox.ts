import { codeStorageClient, codeStorageConfigured } from '../codestorage/client'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { loomsStub } from '../looms-stub'
import { sandboxesArePersonal, userOfSandbox, userSandboxName } from '../sandbox/names'
import {
  findSavedWork,
  latestSave,
  listSavedFiles,
  readSavedFile,
  savedDiffs,
  type SavedRepo,
  type SavedWorkClient,
} from '../sandbox/saved-work'
import type { Actor } from '../tenancy/access'
import { previewKeyFor } from '../tenancy/previews'
import { orgOfRun } from '../tenancy/run-id'

const MAX_FILE_BYTES = 512_000

/** `index.ts` has already checked that `actor` may open the session the path names. */
export async function handleSandboxRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)

  const match = url.pathname.match(
    /^\/sessions\/([^/]+)\/sandbox\/(files|file|diff|terminal|preview|place)$/,
  )

  if (!match) {
    return null
  }

  const runId = decodeURIComponent(match[1] ?? '')
  const action = match[2]

  if (!runId || !action) {
    return Response.json({ error: 'Invalid sandbox path' }, { status: 400 })
  }

  if (action === 'preview') {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    if (!env.AUTH_DB) {
      return Response.json({ error: 'Previews are unavailable' }, { status: 503 })
    }

    // The label for this session's preview hostname; see `tenancy/previews.ts`.
    return Response.json({ label: await previewKeyFor(env.AUTH_DB, runId) })
  }

  const personal = sandboxesArePersonal(env)

  // A terminal is a shell with its owner's sign-ins in reach, so where sandboxes are personal it
  // opens in the viewer's own, never in the one the session happens to be working in.
  const own = personal ? userSandboxName(actor.orgId, actor.userId) : null

  if (action === 'terminal') {
    const target = new URL(request.url)

    // Starts in the session's files when this sandbox has them; the sandbox falls back if not.
    if (!target.searchParams.get('cwd')) {
      target.searchParams.set('cwd', `/workspace/.wt/${runId}`)
    }

    return forwardTerminal(
      new Request(target, request),
      sandboxStub(env, own ?? (await resolveSandboxName(env, runId))),
      env,
    )
  }

  if (action === 'place') {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    // Whose sandbox holds the session's files, so a terminal can say when that is not the
    // viewer's. Null where sandboxes are shared, or before the session has worked anywhere.
    const home = personal ? await loomsStub(env.LOOMS_RUN, runId).getSandboxName() : null
    const holderId = home ? userOfSandbox(home) : null

    return Response.json({ personal, holderId, here: !personal || home === own })
  }

  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const stub = sandboxStub(env, await resolveSandboxName(env, runId))

  // Looking never wakes a sandbox. While the one that holds the session is asleep, the tabs
  // show the session's work as it was last saved.
  const asleep =
    sandboxesArePersonal(env) && !(await stub.isAwake().catch(() => ({ awake: true }))).awake

  if (asleep) {
    return savedView(env, runId, action, url.searchParams.get('path'))
  }

  switch (action) {
    case 'files':
      return listFiles(stub, runId)
    case 'file':
      return readFile(stub, runId, url.searchParams.get('path'))
    case 'diff':
      return listDiffs(stub, runId)

    default: {
      const exhaustive: never = action as never

      return exhaustive
    }
  }
}

/** Answers `files`, `file` or `diff` from what the session last saved to Code Storage. */
async function savedView(
  env: ShuttleEnv,
  runId: string,
  action: string,
  pathParam: string | null,
): Promise<Response> {
  const sessionRoot = `/workspace/.wt/${runId}`
  const orgId = orgOfRun(runId)
  let client: SavedWorkClient | null = null
  let saved: SavedRepo[] = []

  try {
    if (orgId && codeStorageConfigured(env)) {
      // The SDK's lists are also promises of their first page; only the iteration is used here.
      client = codeStorageClient(env) as unknown as SavedWorkClient

      saved = await findSavedWork(
        client,
        orgId,
        runId,
        await loomsStub(env.LOOMS_RUN, runId).getSessionRepos(),
      )
    }

    // `asleep` with nothing saved: there is nothing to show until someone asks for work.
    const from = { source: saved.length > 0 ? 'saved' : 'asleep', savedAt: latestSave(saved) }

    if (!client || saved.length === 0) {
      return action === 'file'
        ? Response.json(
            { error: 'The sandbox is asleep and this file was not saved' },
            { status: 404 },
          )
        : Response.json({ root: sessionRoot, files: [], diffs: [], mode: 'container', ...from })
    }

    if (action === 'files') {
      const files = (await listSavedFiles(client, saved)).map((path) => ({ path, kind: 'file' }))

      return Response.json({ root: sessionRoot, files, mode: 'container', ...from })
    }

    if (action === 'diff') {
      const diffs = (await savedDiffs(client, saved)).map(({ name, diff }) => ({
        cwd: `${sessionRoot}/${name}`,
        name,
        diff,
      }))

      return Response.json({ diffs, ...from })
    }

    const relative = worktreePath(sessionRoot, pathParam)

    if (relative === null) {
      return Response.json(
        { error: 'path is required and must be in the session worktree' },
        { status: 400 },
      )
    }

    const content = await readSavedFile(client, saved, relative)

    if (content === null) {
      return Response.json(
        { path: `${sessionRoot}/${relative}`, error: 'No such file' },
        { status: 404 },
      )
    }

    return Response.json({ ...fileBody(`${sessionRoot}/${relative}`, content), ...from })
  } catch (cause) {
    return Response.json(
      {
        root: sessionRoot,
        files: [],
        diffs: [],
        error: cause instanceof Error ? cause.message : String(cause),
      },
      { status: 500 },
    )
  }
}

/** `path` relative to the session's worktree, or null when it is missing or points outside it. */
function worktreePath(sessionRoot: string, path: string | null): string | null {
  if (!path) {
    return null
  }

  const relative = path.startsWith('/')
    ? path.startsWith(`${sessionRoot}/`)
      ? path.slice(sessionRoot.length + 1)
      : null
    : path.replace(/^\.\//, '')

  return relative && !relative.split('/').includes('..') ? relative : null
}

function fileBody(path: string, content: string) {
  const truncated = content.length > MAX_FILE_BYTES

  return {
    path,
    content: truncated ? content.slice(0, MAX_FILE_BYTES) : content,
    binary: looksBinary(content.slice(0, 4096)),
    truncated,
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

    return Response.json({ root: sessionRoot, files: entries, mode: mode.mode, source: 'sandbox' })
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

    return Response.json({ ...fileBody(absolute, result.content), source: 'sandbox' })
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

    return Response.json({ diffs, source: 'sandbox' })
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
