import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'

import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import type { LinkedSandboxRepo } from '../sandbox/workspace'
import type { SandboxBinding } from '../session/bind-sandbox'
import { readSandboxBinding, sandboxNameForSession } from '../session/bind-sandbox'
import { prepareSessionSandbox } from '../session/handoff'

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

    const primary = binding.repos[0]?.name ?? 'demo'
    return {
      cwd: `/workspace/.wt/${runId}/${primary}`,
      repos: binding.repos as LinkedSandboxRepo[],
    }
  }

  const onAbort = async (): Promise<void> => {
    const binding = await resolveBinding()
    await sandboxStub(env, binding.sandboxName).kill()
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
    description: 'Write a file in the worker worktree',
    input: z.object({
      path: z.string(),
      content: z.string(),
    }),
    handler: async ({ path, content }, ctx) => {
      const { cwd } = await prepare()
      const binding = await resolveBinding()

      await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).writeFile(path, content, cwd),
        onAbort,
      )

      return { path, ok: true }
    },
  })

  const editFile = defineTool({
    name: 'edit_file',
    description: 'Replace old_text with new_text in a file (exact match)',
    input: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
    handler: async ({ path, old_text, new_text }, ctx) => {
      const { cwd } = await prepare()
      const binding = await resolveBinding()

      const result = await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).editFile(path, old_text, new_text, cwd),
        onAbort,
      )

      return { path, replacements: result.replacements }
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
      const { cwd } = await prepare()
      const binding = await resolveBinding()

      const result = await withAbort(
        ctx.signal,
        () => sandboxStub(env, binding.sandboxName).gitDiff(cwd),
        onAbort,
      )

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
