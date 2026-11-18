import { ORPCError } from '@orpc/server'
import { z } from 'zod'

import {
  FileDiagnostics,
  parseComparison,
  type SandboxBranch,
  type SandboxPlace,
  type SandboxWorkspaceRepo,
} from '@shuttle/api'

import { LSP_CLI_PATH, LSP_DEFAULT_WAIT_MS } from '../../bridge/lsp/protocol'
import { codeStorageClient, codeStorageConfigured } from '../codestorage/client'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { loomsStub } from '../looms-stub'
import { shellQuote } from '../sandbox/exec-argv'
import {
  DEMO_REPO,
  deviceOfSandbox,
  isDemoRepo,
  isLocalSandbox,
  localSandboxName,
  providerIdForSandbox,
  sandboxCarriesWork,
  sandboxesArePersonal,
  sandboxIsPersonal,
  userOfSandbox,
  userSandboxName,
} from '../sandbox/names'
import { repoAccess } from '../sandbox/repo-access'
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
import { worktreeRepoPath, type LinkedSandboxRepo } from '../sandbox/workspace'
import {
  branchesScript,
  fetchBranchScript,
  repoDiffScript,
  type SummaryRepo,
  type WorkspaceRepoSummary,
} from '../sandbox/workspace-summary'
import type { SessionStacks } from '../session/stack-state'
import type { Actor } from '../tenancy/access'
import { previewKeyFor } from '../tenancy/previews'
import { orgOfRun } from '../tenancy/run-id'
import { api, badRequest, forbidden, notFound } from './base'

const sandbox = api.sandbox

const MAX_FILE_BYTES = 512_000

type SandboxStub = ReturnType<typeof sandboxStub>

/**
 * The sandbox a session runs in, as the session itself recorded it when it bound one. Nothing in
 * the request chooses it, so a caller cannot name a sandbox it has no session in. A session that
 * has not bound a sandbox yet has nothing to show, and gets an empty one named after itself.
 */
export async function resolveSandboxName(env: ShuttleEnv, runId: string): Promise<string> {
  return (await loomsStub(env.LOOMS_RUN, runId).getSandboxName()) ?? runId
}

/** The sandbox that holds a session, and whether it is one person's. */
async function sessionSandbox(env: ShuttleEnv, runId: string) {
  const name = await resolveSandboxName(env, runId)

  return { name, stub: sandboxStub(env, name), personal: sandboxIsPersonal(name, env) }
}

/**
 * Looking never wakes a sandbox. While the one that holds the session is asleep, the tabs
 * show the session's work as it was last saved.
 */
async function isAsleep(home: { stub: SandboxStub; personal: boolean }): Promise<boolean> {
  return home.personal && !(await home.stub.isAwake().catch(() => ({ awake: true }))).awake
}

/** What went wrong, said to the caller as it was before: a 500 that carries the reason. */
function failure(cause: unknown): Error {
  return cause instanceof ORPCError
    ? cause
    : new ORPCError('INTERNAL_SERVER_ERROR', {
        message: cause instanceof Error ? cause.message : String(cause),
      })
}

async function reporting<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (cause) {
    throw failure(cause)
  }
}

/**
 * Where a session's files are, and where they could go.
 *
 * `holderId` and `here` say whose sandbox holds them, so a terminal can say when that is not the
 * viewer's. `sandbox` describes that sandbox: the provider it runs on and, for one on a person's
 * machine, the machine and whether it is connected. `local` is set while the session is placed
 * on a machine, whoever it is working for at the moment.
 */
async function sessionPlace(env: ShuttleEnv, actor: Actor, runId: string): Promise<SandboxPlace> {
  const run = loomsStub(env.LOOMS_RUN, runId)
  const home = await run.getSandboxName()
  const placement = await run.getSandboxPlacement()

  const personal =
    home !== null && home !== '' ? sandboxIsPersonal(home, env) : sandboxesArePersonal(env)

  const local = home !== null && isLocalSandbox(home)

  const machine = local
    ? await sandboxStub(env, home)
        .describe()
        .catch(() => ({ online: false }))
    : null

  const cloud = providerIdForSandbox('', env)
  const moves = await run.getSandboxMoves()

  return {
    // A move that is waiting for the session to stop working.
    pending: moves.pending ? (moves.pending.placement ? 'local' : 'cloud') : null,
    // Set when the session last left a machine that could not be reached. What it took was that
    // machine's last save; anything changed there afterwards is still there.
    leftBehind:
      moves.last?.fromSave === true && isLocalSandbox(moves.last.from)
        ? { deviceId: deviceOfSandbox(moves.last.from), at: moves.last.at }
        : null,
    personal,
    holderId: personal && home !== null && home !== '' ? userOfSandbox(home) : null,
    here:
      !personal ||
      (local
        ? userOfSandbox(home) === actor.userId
        : home === userSandboxName(actor.orgId, actor.userId)),
    sandbox: local
      ? {
          provider: home !== '' ? providerIdForSandbox(home, env) : cloud,
          location: 'local',
          deviceId: deviceOfSandbox(home),
          ...machine,
        }
      : {
          provider: home !== null && home !== '' ? providerIdForSandbox(home, env) : cloud,
          location: 'cloud',
          ...machine,
        },
    local: placement
      ? { deviceId: placement.deviceId, mine: placement.userId === actor.userId }
      : null,
    cloud: {
      provider: cloud,
      // Work travels through Code Storage, between sandboxes that have a machine behind them.
      movable: codeStorageConfigured(env) && sandboxCarriesWork('', env),
    },
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

/** `path` relative to the session's worktree, or null when it is missing or points outside it. */
function worktreePath(sessionRoot: string, path: string | undefined): string | null {
  if (path === undefined || path === '') {
    return null
  }

  const relative = path.startsWith('/')
    ? path.startsWith(`${sessionRoot}/`)
      ? path.slice(sessionRoot.length + 1)
      : null
    : path.replace(/^\.\//, '')

  return relative !== null && relative !== '' && !relative.split('/').includes('..')
    ? relative
    : null
}

/** Splits `<repository>/<path>` into the session repository it names and the path inside it. */
async function repoFile(env: ShuttleEnv, runId: string, path: string | undefined) {
  const relative = worktreePath(`/workspace/.wt/${runId}`, path)
  const slash = relative?.indexOf('/') ?? -1

  const repo = (await sessionRepos(env, runId)).find(
    (item) => item.name === relative?.slice(0, slash),
  )

  return relative !== null && relative !== '' && slash > 0 && repo !== undefined
    ? { repo, relative, inRepo: relative.slice(slash + 1) }
    : null
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

/**
 * What the session last saved to Code Storage, for answering while its sandbox sleeps. `work` is
 * null when nothing was saved: there is nothing to show until someone asks for work.
 */
async function savedWork(env: ShuttleEnv, runId: string) {
  const orgId = orgOfRun(runId)
  let client: SavedWorkClient | null = null
  let saved: SavedRepo[] = []

  if (orgId !== null && orgId !== '' && codeStorageConfigured(env)) {
    client = codeStorageClient(env)

    saved = await findSavedWork(
      client,
      orgId,
      runId,
      await loomsStub(env.LOOMS_RUN, runId).getSessionRepos(),
    )
  }

  return {
    from: {
      source: saved.length > 0 ? ('saved' as const) : ('asleep' as const),
      savedAt: latestSave(saved),
    },
    work: client && saved.length > 0 ? { client, saved } : null,
  }
}

/** Longest a whole repository's diff is waited for. */
const DIFF_TIMEOUT_MS = 20_000

/**
 * What the sandbox's language server says about one file, for the editor to draw: the file as
 * saved, or, given `draft`, text someone is typing and has not saved. `path` is
 * `<repository>/<path>`.
 *
 * Always answers with a status: a sandbox that is asleep, has no language server, or has one
 * that is still starting is not an error to the person looking at a file.
 */
async function diagnostics(
  env: ShuttleEnv,
  runId: string,
  path: string,
  draft?: string,
): Promise<FileDiagnostics> {
  const file = await repoFile(env, runId, path)

  if (!file) {
    throw badRequest('path must be a file in one of the session repositories')
  }

  const { stub } = await sessionSandbox(env, runId)

  // Looking never wakes a sandbox.
  if (!(await stub.isAwake().catch(() => ({ awake: true }))).awake) {
    return { status: 'unavailable', reason: 'The sandbox is asleep.' }
  }

  const absolute = `/workspace/.wt/${runId}/${file.relative}`
  let command = `[ -f ${LSP_CLI_PATH} ] && node ${LSP_CLI_PATH} diagnostics ${shellQuote(absolute)} --wait-ms ${LSP_DEFAULT_WAIT_MS}`

  try {
    if (draft !== undefined) {
      // shuttle-lsp reads the draft from this file once and deletes it.
      const draftFile = `/tmp/shuttle-lsp-draft-${crypto.randomUUID()}`

      await stub.writeFile(draftFile, draft)
      command += ` --text-file ${draftFile}`
    }

    const result = await stub.exec(command, { timeoutMs: LSP_DEFAULT_WAIT_MS + 7000 })

    return parseDiagnosticsReply(result.stdout)
  } catch (cause) {
    return { status: 'error', reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

function parseDiagnosticsReply(stdout: string): FileDiagnostics {
  let printed: unknown

  try {
    printed = JSON.parse(stdout.trim())
  } catch {
    // Nothing printed: this sandbox's image has no shuttle-lsp.
    return { status: 'unavailable', reason: 'This sandbox has no language server.' }
  }

  const reply = FileDiagnostics.safeParse(printed)

  if (reply.success) {
    return reply.data
  }

  return z.union([z.looseObject({}), z.array(z.unknown())]).safeParse(printed).success
    ? { status: 'error', reason: 'The language server gave an answer that could not be read.' }
    : { status: 'unavailable', reason: 'This sandbox has no language server.' }
}

/** Longest a branch fetched for a comparison, or the list of branches, is waited for. */
const FETCH_TIMEOUT_MS = 30_000

/** How long a branch that could not be fetched is not asked for again, in milliseconds. */
const FETCH_RETRY_MS = 60_000

/** Branches that could not be fetched lately, so the workspace's polling does not ask every time. */
const failedFetches = new Map<string, number>()

/** The `-c` option that sends a repository's credential with one git command. */
async function gitAuth(env: ShuttleEnv, runId: string, repo: LinkedSandboxRepo): Promise<string> {
  const { basicAuth } = await repoAccess(env, repo, orgOfRun(runId))

  return `-c http.extraheader=${shellQuote(`Authorization: Basic ${basicAuth}`)}`
}

/** The branches a comparison names that may be on GitHub and not yet in the sandbox. */
function fetchableRefs(against: string): string[] {
  const parsed = parseComparison(against)

  const refs =
    parsed?.kind === 'ref'
      ? [parsed.ref]
      : parsed?.kind === 'range'
        ? [parsed.base, parsed.head]
        : []

  // A commit is fetched with the branch that holds it, not by itself.
  return refs.filter((ref) => !/^[0-9a-f]{7,40}$/.test(ref))
}

/**
 * Fetches the branches `against` names into a repository's sandbox, for a comparison that found
 * them missing. True when any fetch was tried, so the comparison is worth measuring again.
 */
async function fetchForComparison(
  env: ShuttleEnv,
  stub: SandboxStub,
  runId: string,
  repo: LinkedSandboxRepo,
  against: string,
): Promise<boolean> {
  if (isDemoRepo(repo)) {
    return false
  }

  const now = Date.now()

  const refs = fetchableRefs(against).filter(
    (ref) => (failedFetches.get(`${runId}:${repo.name}:${ref}`) ?? 0) < now - FETCH_RETRY_MS,
  )

  if (refs.length === 0) {
    return false
  }

  const auth = await gitAuth(env, runId, repo)

  for (const ref of refs) {
    const result = await stub
      .exec(fetchBranchScript(auth, ref), {
        cwd: worktreeRepoPath(runId, repo.name),
        timeoutMs: FETCH_TIMEOUT_MS,
      })
      .catch(() => ({ exitCode: 1 }))

    if (result.exitCode !== 0) {
      failedFetches.set(`${runId}:${repo.name}:${ref}`, now)
    }
  }

  return true
}

/** What the workspace says about one repository measured in the sandbox. */
/**
 * What the session last published of each branch of a repository, from the stacks it keeps.
 * A repository's first stack is kept under its name and the others under `name#stack`.
 */
export function publishedBranches(
  stacks: SessionStacks,
  repoName: string,
): { branch: string; tree: string }[] {
  return Object.entries(stacks)
    .filter(([key]) => key === repoName || key.startsWith(`${repoName}#`))
    .flatMap(([, stack]) => stack.layers)
    .filter((layer) => layer.pull !== null && layer.publishedTree !== '')
    .map((layer) => ({ branch: layer.branch, tree: layer.publishedTree }))
}

function measuredRepo(
  repo: LinkedSandboxRepo,
  against: string,
  found: WorkspaceRepoSummary | undefined,
  stacks: SessionStacks,
): SandboxWorkspaceRepo {
  const measure = found?.measure
  const name = describeRepo(repo)

  const wanted = fetchableRefs(against).join(' or ')

  return {
    ...name,
    files: found?.files ?? [],
    changes: found?.changes ?? [],
    head: found?.head ?? null,
    dirty: found?.dirty ?? false,
    sessionBaseSha: found?.sessionBaseSha ?? null,
    commits: found?.commits ?? [],
    published: publishedBranches(stacks, repo.name),
    comparison: {
      against,
      baseSha: measure?.baseSha ?? null,
      baseMode: measure?.baseMode ?? null,
      headSha: measure?.headSha ?? null,
      error:
        measure?.error === 'missing'
          ? `${wanted === '' ? 'That commit' : wanted} is not in ${name.fullName ?? 'this repository'}, or the sandbox could not fetch it.`
          : null,
    },
  }
}

export const sandboxRouter = {
  files: sandbox.files.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const sessionRoot = `/workspace/.wt/${runId}`
    const home = await sessionSandbox(env, runId)

    return reporting(async () => {
      if (await isAsleep(home)) {
        const { from, work } = await savedWork(env, runId)

        const files = work
          ? (await listSavedFiles(work.client, work.saved)).map((path) => ({
              path,
              kind: 'file' as const,
            }))
          : []

        return { root: sessionRoot, files, mode: 'container' as const, ...from }
      }

      const mode = await home.stub.getMode()
      const { files } = await home.stub.listFiles(sessionRoot)

      const relative = files
        .map((path) =>
          path.startsWith(`${sessionRoot}/`) ? path.slice(sessionRoot.length + 1) : path,
        )
        .filter((path) => path.length > 0 && !path.includes('\0'))

      const entries = relative.map((path) => ({ path, kind: 'file' as const }))

      return { root: sessionRoot, files: entries, mode: mode.mode, source: 'sandbox' as const }
    })
  }),

  file: sandbox.file.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const sessionRoot = `/workspace/.wt/${runId}`
    const base = input.version === 'base' || input.version === 'head'
    const home = await sessionSandbox(env, runId)

    if (await isAsleep(home)) {
      return reporting(async () => {
        const { from, work } = await savedWork(env, runId)

        if (!work) {
          throw notFound('The sandbox is asleep and this file was not saved')
        }

        const relative = worktreePath(sessionRoot, input.path)

        if (relative === null) {
          throw badRequest('path is required and must be in the session worktree')
        }

        // A saved copy measures from the session's start, and has no commit to show for a range.
        if (input.version === 'head') {
          throw notFound('Wake the sandbox to read this file at that commit')
        }

        if (base) {
          const started = await readSavedBaseFile(work.client, work.saved, relative)

          if (!started) {
            throw notFound('This saved copy does not record where the session started')
          }

          return { path: `${sessionRoot}/${relative}`, content: started.content, ...from }
        }

        const content = await readSavedFile(work.client, work.saved, relative)

        if (content === null) {
          throw notFound('No such file')
        }

        return { ...fileBody(`${sessionRoot}/${relative}`, content), ...from }
      })
    }

    // The file where its changes are measured from, or, for a range, at the commit they are
    // measured to. `content` is null when it did not exist there.
    if (base) {
      const file = await repoFile(env, runId, input.path)

      if (!file) {
        throw badRequest('path must name a file in one of the session repositories')
      }

      return reporting(async () => {
        const { content } = await home.stub.baseFile(
          runId,
          { ...file.repo, against: input.against },
          file.inRepo,
          input.version === 'head' ? 'head' : 'base',
        )

        return { path: file.relative, content, source: 'sandbox' as const }
      })
    }

    const absolute = input.path.startsWith('/')
      ? input.path
      : `${sessionRoot}/${input.path.replace(/^\.\//, '')}`

    if (!absolute.startsWith(`${sessionRoot}/`) && absolute !== sessionRoot) {
      throw badRequest('path escapes session worktree')
    }

    const result = await home.stub.readFile(absolute).catch((cause: unknown) => {
      throw notFound(cause instanceof Error ? cause.message : String(cause))
    })

    if (result.missing === true) {
      throw notFound(result.error)
    }

    return { ...fileBody(absolute, result.content), source: 'sandbox' as const }
  }),

  diff: sandbox.diff.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const sessionRoot = `/workspace/.wt/${runId}`
    const home = await sessionSandbox(env, runId)

    if (await isAsleep(home)) {
      return reporting(async () => {
        const { from, work } = await savedWork(env, runId)

        if (!work) {
          return { diffs: [], ...from }
        }

        if (input.path !== undefined && input.path !== '') {
          const relative = worktreePath(sessionRoot, input.path)

          return {
            path: relative,
            diff: relative !== null ? await savedFileDiff(work.client, work.saved, relative) : '',
            ...from,
          }
        }

        const diffs = (await savedDiffs(work.client, work.saved)).map(({ name, diff }) => ({
          cwd: `${sessionRoot}/${name}`,
          name,
          diff,
        }))

        return { diffs, ...from }
      })
    }

    // One file's changes since the session started. `path` is `<repository>/<path>`.
    if (input.path !== undefined && input.path !== '') {
      const file = await repoFile(env, runId, input.path)

      if (!file) {
        throw badRequest('path must name a file in one of the session repositories')
      }

      return reporting(async () => {
        const { diff } = await home.stub.fileDiff(
          runId,
          { ...file.repo, against: input.against },
          file.inRepo,
        )

        return { path: file.relative, diff, source: 'sandbox' as const }
      })
    }

    // Every repository's changes since the session started, uncommitted work included. For a
    // review session that is what the pull request changes: its worktree is the head, measured
    // from the base.
    return reporting(async () => {
      const diffs = []

      for (const repo of await sessionRepos(env, runId)) {
        const cwd = worktreeRepoPath(runId, repo.name)

        const result = await home.stub.exec(repoDiffScript(repo.defaultBranch), {
          cwd,
          timeoutMs: DIFF_TIMEOUT_MS,
        })

        if (result.exitCode === 0 && result.stdout.trim() !== '') {
          diffs.push({ cwd, name: repo.name, diff: result.stdout })
        }
      }

      return { diffs, source: 'sandbox' as const }
    })
  }),

  branches: sandbox.branches.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const repo = (await sessionRepos(env, runId)).find((item) => item.name === input.repo)

    if (!repo) {
      throw notFound('No such repository in this session')
    }

    const home = await sessionSandbox(env, runId)

    return reporting(async () => {
      // Listing branches never wakes a sandbox.
      if (await isAsleep(home)) {
        return { branches: [] }
      }

      const auth = isDemoRepo(repo) ? '' : await gitAuth(env, runId, repo)

      const result = await home.stub.exec(branchesScript(auth), {
        cwd: worktreeRepoPath(runId, repo.name),
        timeoutMs: FETCH_TIMEOUT_MS,
      })

      const branches = new Map<string, SandboxBranch>()

      for (const line of result.stdout.split('\n')) {
        const [kind, name] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]

        if (name !== '' && (kind === 'REMOTE' || kind === 'LOCAL')) {
          branches.set(name, {
            name,
            remote: kind === 'REMOTE' || branches.get(name)?.remote === true,
          })
        }
      }

      // The default branch first, then GitHub's, then the sandbox's own.
      return {
        branches: [...branches.values()].toSorted((a, b) => {
          const byDefault =
            Number(b.name === repo.defaultBranch) - Number(a.name === repo.defaultBranch)

          if (byDefault !== 0) {
            return byDefault
          }

          const byRemote = Number(b.remote) - Number(a.remote)

          return byRemote === 0 ? a.name.localeCompare(b.name) : byRemote
        }),
      }
    })
  }),

  workspace: sandbox.workspace.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const home = await sessionSandbox(env, runId)
    const againstOf = (repo: LinkedSandboxRepo) => input.against?.[repo.name] ?? 'session'

    const asked = (list: readonly LinkedSandboxRepo[]): SummaryRepo[] =>
      list.map((repo) => ({ ...repo, against: againstOf(repo) }))

    return reporting(async () => {
      if (await isAsleep(home)) {
        const { from, work } = await savedWork(env, runId)
        const repos = await sessionRepos(env, runId)
        const summaries = new Map<string, WorkspaceRepoSummary>()

        if (work) {
          for (const repo of work.saved) {
            summaries.set(repo.name, await savedRepoSummary(work.client, repo))
          }
        }

        return {
          ...from,
          holderId: null,
          repos: repos.map((repo) => ({
            ...describeRepo(repo),
            files: summaries.get(repo.name)?.files ?? [],
            changes: summaries.get(repo.name)?.changes ?? [],
          })),
          strays: [],
        }
      }

      // The session's workspace as it stands in the sandbox it is in, each repository measured
      // the way it was asked for.
      const repos = await sessionRepos(env, runId)
      const summary = await home.stub.workspaceSummary(runId, asked(repos))
      const found = new Map(summary.repos.map((repo) => [repo.name, repo]))

      // A branch compared with may be on GitHub and not in the sandbox yet: fetch it and measure
      // those repositories again.
      const refetched: LinkedSandboxRepo[] = []

      for (const repo of repos) {
        if (
          found.get(repo.name)?.measure?.error === 'missing' &&
          (await fetchForComparison(env, home.stub, runId, repo, againstOf(repo)))
        ) {
          refetched.push(repo)
        }
      }

      if (refetched.length > 0) {
        for (const repo of (await home.stub.workspaceSummary(runId, asked(refetched))).repos) {
          found.set(repo.name, repo)
        }
      }

      const run = loomsStub(env.LOOMS_RUN, runId)
      const activity = await run.getSessionActivitySnapshot().catch(() => null)

      // Without them, whether a branch is pushed is told by its commit alone.
      const stacks = await run.getSessionStacks().catch((): SessionStacks => ({}))

      return {
        source: 'sandbox' as const,
        // People edit between turns, not under a running agent.
        working: activity?.activity === 'working',
        holderId: home.personal ? userOfSandbox(home.name) : null,
        repos: repos.map((repo) =>
          measuredRepo(repo, againstOf(repo), found.get(repo.name), stacks),
        ),
        strays: summary.strays,
      }
    })
  }),

  /**
   * Saves a person's edit to one file in the session's workspace.
   *
   * It is refused while an agent is working, so a person and an agent never write the same file
   * at once, and while the sandbox is asleep, because the saved copy is not somewhere to write.
   * `expected` is the text the person started from: if the file has changed since, the edit is
   * refused rather than laid over someone else's work.
   */
  write: sandbox.write.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const file = await repoFile(env, runId, input.path)

    if (!file) {
      throw badRequest('A file in the workspace and its new text are required')
    }

    const home = await sessionSandbox(env, runId)

    if (await isAsleep(home)) {
      throw new ORPCError('CONFLICT', {
        message: 'The sandbox is asleep. Send a message to wake it, then edit.',
      })
    }

    const activity = await loomsStub(env.LOOMS_RUN, runId)
      .getSessionActivitySnapshot()
      .catch(() => null)

    if (activity?.activity === 'working') {
      throw new ORPCError('CONFLICT', {
        message: 'Agents are working in this session. Edit once they have finished.',
      })
    }

    const absolute = `/workspace/.wt/${runId}/${file.relative}`

    return reporting(async () => {
      if (input.expected !== undefined) {
        const current = await home.stub.readFile(absolute)

        if (current.missing === true || current.content !== input.expected) {
          throw new ORPCError('CONFLICT', {
            message:
              'This file changed while you were editing it. Reload it and make the edit again.',
            data: { changed: true },
          })
        }
      }

      await home.stub.writeFile(absolute, input.content)

      return { ok: true as const, path: file.relative }
    })
  }),

  /** Moves something an agent wrote outside the worktree into the session's first repository. */
  adopt: sandbox.adopt.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const [repo] = await sessionRepos(env, runId)

    if (!repo) {
      throw badRequest('path is required')
    }

    const { stub } = await sessionSandbox(env, runId)
    const moved = await stub.adoptStray(runId, repo.name, input.path)

    if (!moved.ok) {
      throw new ORPCError('CONFLICT', { message: moved.error ?? 'It could not be moved' })
    }

    return { ok: true as const }
  }),

  diagnostics: {
    saved: sandbox.diagnostics.saved.handler(async ({ input, context: { env } }) =>
      diagnostics(env, input.id, input.path),
    ),

    draft: sandbox.diagnostics.draft.handler(async ({ input, context: { env } }) =>
      diagnostics(env, input.params.id, input.query.path, input.body.content),
    ),
  },

  place: {
    get: sandbox.place.get.handler(async ({ input, context: { env, actor } }) =>
      sessionPlace(env, actor, input.id),
    ),

    /**
     * Moves a session to the caller's own machine (`{ to: 'local', deviceId }`) or back to the
     * cloud (`{ to: 'cloud' }`), with its work. A session is only moved between turns.
     */
    move: sandbox.place.move.handler(async ({ input, context: { env, actor } }) => {
      const runId = input.id
      const run = loomsStub(env.LOOMS_RUN, runId)

      // Between an agent's steps a session can look idle for a moment, so the sandbox is asked
      // too: a command running there would keep writing after its files had been carried away.
      const home = await run.getSandboxName()

      const working =
        (await run.getSessionActivitySnapshot().catch(() => null))?.activity === 'working' ||
        (home !== null &&
          (
            await sandboxStub(env, home)
              .isBusy()
              .catch(() => ({ busy: false }))
          ).busy)

      if (input.to === 'cloud') {
        const placement = await run.getSandboxPlacement()

        // Leaving a machine takes the session's files off it, so only its owner may.
        if (placement && placement.userId !== actor.userId) {
          throw forbidden("Only the machine's owner can move it")
        }
      } else {
        // The name is built from the caller, so the machine is one of their own.
        const machine = await sandboxStub(
          env,
          localSandboxName(actor.orgId, actor.userId, input.deviceId),
        )
          .describe()
          .catch(() => ({ online: false }))

        if (!machine.online) {
          throw new ORPCError('CONFLICT', {
            message: 'That machine is not connected. Open the Shuttle desktop app on it first.',
          })
        }
      }

      const placement =
        input.to === 'local'
          ? ({ kind: 'local', userId: actor.userId, deviceId: input.deviceId } as const)
          : null

      // Work is never carried out from under a running turn. The move waits for it to end.
      if (working) {
        await run.placeSandboxLater(placement)

        return sessionPlace(env, actor, runId)
      }

      try {
        const { moved } = await run.placeSandbox(placement)

        if (moved) {
          const machine = isLocalSandbox(moved.from) ? moved.from : moved.to

          const device = isLocalSandbox(machine)
            ? (
                await sandboxStub(env, machine)
                  .describe()
                  .catch(() => null)
              )?.device?.name
            : undefined

          const from = isLocalSandbox(moved.from) ? 'local' : 'cloud'
          const to = isLocalSandbox(moved.to) ? 'local' : 'cloud'

          // In the session's history, so it shows where each stretch of work happened.
          await run
            .signal([
              {
                type: 'shuttle.sandbox.moved',
                payload:
                  device === undefined || device === ''
                    ? { from, to, fromSave: moved.fromSave }
                    : { from, to, fromSave: moved.fromSave, device },
                idempotencyKey: `sandbox-moved:${moved.at}`,
                origin: { type: 'external', actorId: actor.userId },
              },
            ])
            .catch(() => {})
        }
      } catch (cause) {
        throw new ORPCError('BAD_GATEWAY', {
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }

      return sessionPlace(env, actor, runId)
    }),
  },

  preview: sandbox.preview.handler(async ({ input, context: { env } }) => {
    if (!env.AUTH_DB) {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Previews are unavailable' })
    }

    // The label for this session's preview hostname (see `tenancy/previews.ts`), and the domain
    // the deployment serves previews under.
    const label = await previewKeyFor(env.AUTH_DB, input.id)
    const host = env.SHUTTLE_PREVIEW_HOST

    return host === undefined || host === '' ? { label } : { label, host }
  }),
}
