import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'

import {
  LSP_CLI_PATH,
  LSP_DEFAULT_WAIT_MS,
  toolDiagnostics,
  type ToolDiagnostics,
} from '../../bridge/lsp/protocol'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { shellQuote } from '../sandbox/exec-argv'
import {
  insideSessionWorktree,
  resolvePath,
  sessionWorkDir,
  worktreeRoot,
  type LinkedSandboxRepo,
} from '../sandbox/workspace'
import type { SandboxBinding } from '../session/bind-sandbox'
import { readSandboxBinding, sandboxNameForSession } from '../session/bind-sandbox'
import { prepareSessionSandbox } from '../session/handoff'

/** Longest a tool waits on `shuttle-lsp`: its own wait, plus starting the daemon and a server. */
const DIAGNOSTICS_TIMEOUT_MS = LSP_DEFAULT_WAIT_MS + 7000

async function withAbort<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  onAbort: () => Promise<void>,
): Promise<T> {
  if (!signal) {
    return run()
  }

  if (signal.aborted) {
    await onAbort()
    throw new Error('Aborted')
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbortEvent = () => {
      void onAbort().finally(() => reject(new Error('Aborted')))
    }

    signal.addEventListener('abort', onAbortEvent, { once: true })

    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbortEvent))
  })
}

export function createSandboxTools(env: ShuttleEnv, runId: string, storage?: DurableObjectStorage) {
  let bindingPromise: Promise<SandboxBinding> | null = null

  async function resolveBinding(): Promise<SandboxBinding> {
    bindingPromise ??= (async () => {
      const stored = await readSandboxBinding(storage, runId)

      if (stored) {
        return stored
      }

      return { sandboxName: runId, repos: [] as LinkedSandboxRepo[] }
    })()

    const bound = await bindingPromise

    // Asked each time: the person the session works for, and so its sandbox, can change.
    return {
      ...bound,
      sandboxName: await sandboxNameForSession(env, storage, runId, bound.sandboxName),
    }
  }

  async function prepare(): Promise<{ cwd: string; repos: LinkedSandboxRepo[] }> {
    const binding = await resolveBinding()

    // Sets the sandbox up, and first moves the session into it if it was working elsewhere.
    await prepareSessionSandbox(env, storage, runId, binding)

    return {
      cwd: sessionWorkDir(runId, binding.repos),
      repos: binding.repos as LinkedSandboxRepo[],
    }
  }

  /** What a tool answers when asked to write somewhere the session's work does not live. */
  const outside = (path: string, cwd: string) =>
    insideSessionWorktree(runId, path, cwd)
      ? null
      : {
          path,
          ok: false,
          error: `${path} is outside this session's worktree. Files written there are not shown, saved or shared. Write inside ${worktreeRoot(runId)} instead; a relative path starts in ${cwd}.`,
        }

  const onAbort = async (): Promise<void> => {
    const binding = await resolveBinding()
    await sandboxStub(env, binding.sandboxName).kill()
  }

  /**
   * What the language server says about a file the agent just changed, so a type error shows up
   * in the same turn that caused it. Never fails the write it follows: a sandbox with no
   * language server, or one that is still starting, simply has nothing to add.
   */
  async function diagnose(
    path: string,
    cwd: string,
    sandboxName: string,
    signal: AbortSignal | undefined,
  ): Promise<ToolDiagnostics> {
    const sandbox = sandboxStub(env, sandboxName)
    const execId = crypto.randomUUID()
    const file = shellQuote(resolvePath(path, cwd))

    try {
      const result = await withAbort(
        signal,
        () =>
          sandbox.exec(
            `[ -f ${LSP_CLI_PATH} ] && node ${LSP_CLI_PATH} diagnostics ${file} --wait-ms ${LSP_DEFAULT_WAIT_MS}`,
            { cwd, timeoutMs: DIAGNOSTICS_TIMEOUT_MS, execId },
          ),
        async () => {
          await sandbox.kill(execId)
        },
      )

      return toolDiagnostics(result.stdout)
    } catch (cause) {
      if (signal?.aborted) {
        throw cause
      }

      return {}
    }
  }

  const readFile = defineTool({
    name: 'read_file',
    description: 'Read a file from the session sandbox workspace',
    input: z.object({
      path: z.string(),
    }),
    handler: async ({ path }, ctx) => {
      const { cwd } = await prepare()
      const binding = await resolveBinding()

      const result = await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).readFile(path, cwd),
        onAbort,
      )

      return {
        path,
        content: result.missing ? null : result.content,
        missing: result.missing === true,
        error: result.missing ? result.error : null,
      }
    },
  })

  const writeFile = defineTool({
    name: 'write_file',
    description:
      'Write a file in the worker worktree. The result lists any errors the language server finds in it.',
    input: z.object({
      path: z.string(),
      content: z.string(),
    }),
    handler: async ({ path, content }, ctx) => {
      const { cwd } = await prepare()
      const refused = outside(path, cwd)

      if (refused) {
        return refused
      }

      const binding = await resolveBinding()

      await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).writeFile(path, content, cwd),
        onAbort,
      )

      return { path, ok: true, ...(await diagnose(path, cwd, binding.sandboxName, ctx.signal)) }
    },
  })

  const editFile = defineTool({
    name: 'edit_file',
    description:
      'Replace old_text with new_text in a file (exact match). The result lists any errors the language server finds in the file afterwards.',
    input: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    handler: async ({ path, old_text, new_text }, ctx) => {
      const { cwd } = await prepare()
      const refused = outside(path, cwd)

      if (refused) {
        return refused
      }

      const binding = await resolveBinding()

      const result = await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).editFile(path, old_text, new_text, cwd),
        onAbort,
      )

      return {
        path,
        replacements: result.replacements,
        ...(result.replacements > 0
          ? await diagnose(path, cwd, binding.sandboxName, ctx.signal)
          : {}),
      }
    },
  })

  const grep = defineTool({
    name: 'grep',
    description: 'Search files in the worktree for a regex pattern',
    input: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
    handler: async ({ pattern, path }, ctx) => {
      const { cwd } = await prepare()
      const binding = await resolveBinding()

      const result = await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).grep(pattern, path, cwd),
        onAbort,
      )

      return { matches: result.matches }
    },
  })

  const bash = defineTool({
    name: 'bash',
    description: 'Run a shell command in the shared session worktree',
    input: z.object({
      command: z.string(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
    }),
    handler: async ({ command, timeout_seconds }, ctx) => {
      const { cwd } = await prepare()
      const binding = await resolveBinding()
      const sandbox = sandboxStub(env, binding.sandboxName)
      const timeoutMs = (timeout_seconds ?? 120) * 1000
      const execId = crypto.randomUUID()

      return await withAbort(
        ctx.signal,
        () => sandbox.exec(command, { cwd, timeoutMs, execId }),
        async () => {
          await sandbox.kill(execId)
        },
      )
    },
  })

  const gitDiff = defineTool({
    name: 'git_diff',
    description: 'Show the current git diff in the worker worktree',
    input: z.object({}),
    handler: async (_input, ctx) => {
      const { cwd, repos } = await prepare()
      const binding = await resolveBinding()
      const sandbox = sandboxStub(env, binding.sandboxName)

      // With several repositories the starting directory holds them rather than being one.
      if (repos.length > 1) {
        const all = await withAbort(
          ctx.signal,
          () => sandbox.exec('for repo in */; do (cd "$repo" && git diff); done', { cwd }),
          onAbort,
        )

        return { diff: all.stdout }
      }

      const result = await withAbort(ctx.signal, () => sandbox.gitDiff(cwd), onAbort)

      return { diff: result.diff }
    },
  })

  return { readFile, writeFile, editFile, grep, bash, gitDiff }
}

export function createReadOnlySandboxTools(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const all = createSandboxTools(env, runId, storage)
  return {
    readFile: all.readFile,
    grep: all.grep,
    gitDiff: all.gitDiff,
  }
}
