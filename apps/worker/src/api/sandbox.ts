import { ORPCError } from '@orpc/server'

import { FileDiagnostics, type SandboxPlace } from '@shuttle/api'

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
import { repoDiffScript, type WorkspaceRepoSummary } from '../sandbox/workspace-summary'
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
function failure(cause: unknown): ORPCError<string, unknown> {
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
  const personal = home ? sandboxIsPersonal(home, env) : sandboxesArePersonal(env)
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
      moves.last?.fromSave && isLocalSandbox(moves.last.from)
        ? { deviceId: deviceOfSandbox(moves.last.from), at: moves.last.at }
        : null,
    personal,
    holderId: personal && home ? userOfSandbox(home) : null,
    here:
      !personal ||
      (local
        ? userOfSandbox(home) === actor.userId
        : home === userSandboxName(actor.orgId, actor.userId)),
    sandbox: {
      provider: home ? providerIdForSandbox(home, env) : cloud,
      location: local ? 'local' : 'cloud',
      ...(local ? { deviceId: deviceOfSandbox(home) } : {}),
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

/** Splits `<repository>/<path>` into the session repository it names and the path inside it. */
async function repoFile(env: ShuttleEnv, runId: string, path: string | undefined) {
  const relative = worktreePath(`/workspace/.wt/${runId}`, path)
  const slash = relative?.indexOf('/') ?? -1

  const repo = (await sessionRepos(env, runId)).find(
    (item) => item.name === relative?.slice(0, slash),
  )

  return relative && slash > 0 && repo
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

  return typeof printed === 'object' && printed !== null
    ? { status: 'error', reason: 'The language server gave an answer that could not be read.' }
    : { status: 'unavailable', reason: 'This sandbox has no language server.' }
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
    const base = input.version === 'base'
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

    // The file as it was when the session started. `content` is null when it did not exist then.
    if (base) {
      const file = await repoFile(env, runId, input.path)

      if (!file) {
        throw badRequest('path must name a file in one of the session repositories')
      }

      return reporting(async () => {
        const { content } = await home.stub.baseFile(runId, file.repo, file.inRepo)

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

    if (result.missing) {
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

        if (input.path) {
          const relative = worktreePath(sessionRoot, input.path)

          return {
            path: relative,
            diff: relative ? await savedFileDiff(work.client, work.saved, relative) : '',
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
    if (input.path) {
      const file = await repoFile(env, runId, input.path)

      if (!file) {
        throw badRequest('path must name a file in one of the session repositories')
      }

      return reporting(async () => {
        const { diff } = await home.stub.fileDiff(runId, file.repo, file.inRepo)

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

        if (result.exitCode === 0 && result.stdout.trim()) {
          diffs.push({ cwd, name: repo.name, diff: result.stdout })
        }
      }

      return { diffs, source: 'sandbox' as const }
    })
  }),

  workspace: sandbox.workspace.handler(async ({ input, context: { env } }) => {
    const runId = input.id
    const home = await sessionSandbox(env, runId)

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

      // The session's workspace as it stands in the sandbox it is in.
      const repos = await sessionRepos(env, runId)
      const summary = await home.stub.workspaceSummary(runId, repos)
      const found = new Map(summary.repos.map((repo) => [repo.name, repo]))

      const activity = await loomsStub(env.LOOMS_RUN, runId)
        .getSessionActivitySnapshot()
        .catch(() => null)

      return {
        source: 'sandbox' as const,
        // People edit between turns, not under a running agent.
        working: activity?.activity === 'working',
        holderId: home.personal ? userOfSandbox(home.name) : null,
        repos: repos.map((repo) => ({
          ...describeRepo(repo),
          files: found.get(repo.name)?.files ?? [],
          changes: found.get(repo.name)?.changes ?? [],
        })),
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

        if (current.missing || current.content !== input.expected) {
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

          // In the session's history, so it shows where each stretch of work happened.
          await run
            .signal([
              {
                type: 'shuttle.sandbox.moved',
                payload: {
                  from: isLocalSandbox(moved.from) ? 'local' : 'cloud',
                  to: isLocalSandbox(moved.to) ? 'local' : 'cloud',
                  fromSave: moved.fromSave,
                  ...(device ? { device } : {}),
                },
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
    return {
      label: await previewKeyFor(env.AUTH_DB, input.id),
      ...(env.SHUTTLE_PREVIEW_HOST ? { host: env.SHUTTLE_PREVIEW_HOST } : {}),
    }
  }),
}
