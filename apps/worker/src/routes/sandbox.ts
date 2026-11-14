import { codeStorageClient, codeStorageConfigured } from '../codestorage/client'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { loomsStub } from '../looms-stub'
import {
  DEMO_REPO,
  isDemoRepo,
  sandboxesArePersonal,
  userOfSandbox,
  userSandboxName,
} from '../sandbox/names'
import {
  findSavedWork,
  latestSave,
  listSavedFiles,
  readSavedBaseFile,
  readSavedFile,
  savedDiffs,
  savedFileDiff,
  savedRepoSummary,
  type SavedRepo,
  type SavedWorkClient,
} from '../sandbox/saved-work'
import type { LinkedSandboxRepo } from '../sandbox/workspace'
import type { WorkspaceRepoSummary } from '../sandbox/workspace-summary'
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
    /^\/sessions\/([^/]+)\/sandbox\/(files|file|diff|terminal|preview|place|workspace|adopt|write)$/,
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

  const sandboxName = await resolveSandboxName(env, runId)
  const stub = sandboxStub(env, sandboxName)

  if (action === 'adopt') {
    return adoptStray(request, env, stub, runId)
  }

  if (action === 'write') {
    return writeFile(request, env, stub, runId, personal)
  }

  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  // Looking never wakes a sandbox. While the one that holds the session is asleep, the tabs
  // show the session's work as it was last saved.
  const asleep =
    sandboxesArePersonal(env) && !(await stub.isAwake().catch(() => ({ awake: true }))).awake

  const path = url.searchParams.get('path')

  if (asleep) {
    return savedView(env, runId, action, path, url.searchParams.get('version') === 'base')
  }

  switch (action) {
    case 'files':
      return listFiles(stub, runId)
    case 'file':
      return url.searchParams.get('version') === 'base'
        ? baseFile(env, stub, runId, path)
        : readFile(stub, runId, path)
    case 'diff':
      return path ? fileDiff(env, stub, runId, path) : listDiffs(stub, runId)
    case 'workspace':
      return liveWorkspace(env, stub, runId, personal ? userOfSandbox(sandboxName) : null)

    default: {
      const exhaustive: never = action as never

      return exhaustive
    }
  }
}

/** The repositories a session works in: the ones linked to its folder, or its scratch one. */
async function sessionRepos(env: ShuttleEnv, runId: string): Promise<readonly LinkedSandboxRepo[]> {
  const linked = await loomsStub(env.LOOMS_RUN, runId).getSessionRepos()

  return linked.length > 0 ? linked : [DEMO_REPO]
}

/** How a repository is named to the people looking at it. A scratch one has no GitHub name. */
function describeRepo(repo: LinkedSandboxRepo) {
  return {
    name: repo.name,
    fullName: isDemoRepo(repo) ? null : repo.fullName,
    defaultBranch: repo.defaultBranch,
  }
}

/** The session's workspace as it stands in the sandbox it is in. */
async function liveWorkspace(
  env: ShuttleEnv,
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
  holderId: string | null,
): Promise<Response> {
  try {
    const repos = await sessionRepos(env, runId)
    const summary = await stub.workspaceSummary(runId, repos)
    const found = new Map(summary.repos.map((repo) => [repo.name, repo]))

    const activity = await loomsStub(env.LOOMS_RUN, runId)
      .getSessionActivitySnapshot()
      .catch(() => null)

    return Response.json({
      source: 'sandbox',
      // People edit between turns, not under a running agent.
      working: activity?.activity === 'working',
      holderId,
      repos: repos.map((repo) => ({
        ...describeRepo(repo),
        files: found.get(repo.name)?.files ?? [],
        changes: found.get(repo.name)?.changes ?? [],
      })),
      strays: summary.strays,
    })
  } catch (cause) {
    return Response.json(
      { repos: [], strays: [], error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}

/** One file's changes since the session started. `path` is `<repository>/<path>`. */
async function fileDiff(
  env: ShuttleEnv,
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
  path: string,
): Promise<Response> {
  const relative = worktreePath(`/workspace/.wt/${runId}`, path)
  const slash = relative?.indexOf('/') ?? -1

  const repo = (await sessionRepos(env, runId)).find(
    (item) => item.name === relative?.slice(0, slash),
  )

  if (!relative || slash < 0 || !repo) {
    return Response.json(
      { error: 'path must name a file in one of the session repositories' },
      { status: 400 },
    )
  }

  try {
    const { diff } = await stub.fileDiff(runId, repo, relative.slice(slash + 1))

    return Response.json({ path: relative, diff, source: 'sandbox' })
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}

/** Splits `<repository>/<path>` into the session repository it names and the path inside it. */
async function repoFile(env: ShuttleEnv, runId: string, path: string | null) {
  const relative = worktreePath(`/workspace/.wt/${runId}`, path)
  const slash = relative?.indexOf('/') ?? -1

  const repo = (await sessionRepos(env, runId)).find(
    (item) => item.name === relative?.slice(0, slash),
  )

  return relative && slash > 0 && repo
    ? { repo, relative, inRepo: relative.slice(slash + 1) }
    : null
}

/** One file as it was when the session started. `content` is null when it did not exist then. */
async function baseFile(
  env: ShuttleEnv,
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
  path: string | null,
): Promise<Response> {
  const file = await repoFile(env, runId, path)

  if (!file) {
    return Response.json(
      { error: 'path must name a file in one of the session repositories' },
      { status: 400 },
    )
  }

  try {
    const { content } = await stub.baseFile(runId, file.repo, file.inRepo)

    return Response.json({ path: file.relative, content, source: 'sandbox' })
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}

/** Largest file a person may save from the browser, in characters. */
const MAX_WRITE_CHARS = 2_000_000

/**
 * Saves a person's edit to one file in the session's workspace.
 *
 * It is refused while an agent is working, so a person and an agent never write the same file
 * at once, and while the sandbox is asleep, because the saved copy is not somewhere to write.
 * `expected` is the text the person started from: if the file has changed since, the edit is
 * refused rather than laid over someone else's work.
 */
async function writeFile(
  request: Request,
  env: ShuttleEnv,
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
  personal: boolean,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const body = (await request.json().catch(() => null)) as {
    path?: unknown
    content?: unknown
    expected?: unknown
  } | null

  const file = await repoFile(env, runId, typeof body?.path === 'string' ? body.path : null)

  if (!file || typeof body?.content !== 'string' || body.content.length > MAX_WRITE_CHARS) {
    return Response.json(
      { error: 'A file in the workspace and its new text are required' },
      { status: 400 },
    )
  }

  if (personal && !(await stub.isAwake().catch(() => ({ awake: true }))).awake) {
    return Response.json(
      { error: 'The sandbox is asleep. Send a message to wake it, then edit.' },
      { status: 409 },
    )
  }

  const activity = await loomsStub(env.LOOMS_RUN, runId)
    .getSessionActivitySnapshot()
    .catch(() => null)

  if (activity?.activity === 'working') {
    return Response.json(
      { error: 'Agents are working in this session. Edit once they have finished.' },
      { status: 409 },
    )
  }

  const absolute = `/workspace/.wt/${runId}/${file.relative}`

  try {
    if (typeof body.expected === 'string') {
      const current = await stub.readFile(absolute)

      if (current.missing || current.content !== body.expected) {
        return Response.json(
          {
            error:
              'This file changed while you were editing it. Reload it and make the edit again.',
            changed: true,
          },
          { status: 409 },
        )
      }
    }

    await stub.writeFile(absolute, body.content)

    return Response.json({ ok: true, path: file.relative })
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}

/** Moves something an agent wrote outside the worktree into the session's first repository. */
async function adoptStray(
  request: Request,
  env: ShuttleEnv,
  stub: ReturnType<typeof sandboxStub>,
  runId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const body = (await request.json().catch(() => null)) as { path?: unknown } | null
  const [repo] = await sessionRepos(env, runId)

  if (typeof body?.path !== 'string' || !repo) {
    return Response.json({ error: 'path is required' }, { status: 400 })
  }

  const moved = await stub.adoptStray(runId, repo.name, body.path)

  return Response.json(moved, { status: moved.ok ? 200 : 409 })
}

/** Answers `files`, `file` or `diff` from what the session last saved to Code Storage. */
async function savedView(
  env: ShuttleEnv,
  runId: string,
  action: string,
  pathParam: string | null,
  base = false,
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
      if (action === 'workspace') {
        const repos = await sessionRepos(env, runId)

        return Response.json({
          ...from,
          holderId: null,
          repos: repos.map((repo) => ({ ...describeRepo(repo), files: [], changes: [] })),
          strays: [],
        })
      }

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

    if (action === 'workspace') {
      const repos = await sessionRepos(env, runId)
      const summaries = new Map<string, WorkspaceRepoSummary>()

      for (const repo of saved) {
        summaries.set(repo.name, await savedRepoSummary(client, repo))
      }

      return Response.json({
        ...from,
        holderId: null,
        repos: repos.map((repo) => ({
          ...describeRepo(repo),
          files: summaries.get(repo.name)?.files ?? [],
          changes: summaries.get(repo.name)?.changes ?? [],
        })),
        strays: [],
      })
    }

    if (action === 'diff' && pathParam) {
      const relative = worktreePath(sessionRoot, pathParam)

      return Response.json({
        path: relative,
        diff: relative ? await savedFileDiff(client, saved, relative) : '',
        ...from,
      })
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

    if (base) {
      const started = await readSavedBaseFile(client, saved, relative)

      return started
        ? Response.json({ path: `${sessionRoot}/${relative}`, content: started.content, ...from })
        : Response.json(
            { error: 'This saved copy does not record where the session started' },
            { status: 404 },
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
