import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'

import { sandboxStub, type ShuttleEnv } from '../env'

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

function worktreeCwd(threadId: string): string {
  return `/workspace/.wt/${threadId}`
}

export function createSandboxTools(env: ShuttleEnv, runId: string) {
  const sandbox = () => sandboxStub(env, runId)
  const prepared = new Set<string>()

  async function prepare(threadId: string): Promise<string> {
    if (!prepared.has(threadId)) {
      await sandbox().ensureRepo(null)
      await sandbox().ensureWorktree(threadId)
      prepared.add(threadId)
    }

    return worktreeCwd(threadId)
  }

  const onAbort = async (): Promise<void> => {
    await sandbox().kill()
  }

  const readFile = defineTool({
    name: 'read_file',
    description: 'Read a file from the session sandbox workspace',
    input: z.object({
      path: z.string(),
    }),
    handler: async ({ path }, ctx) => {
      const cwd = await prepare(ctx.threadId)
      const result = await withAbort(ctx.signal, () => sandbox().readFile(path, cwd), onAbort)
      return { path, content: result.content }
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
      const cwd = await prepare(ctx.threadId)
      await withAbort(ctx.signal, () => sandbox().writeFile(path, content, cwd), onAbort)
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
      const cwd = await prepare(ctx.threadId)

      const result = await withAbort(
        ctx.signal,
        () => sandbox().editFile(path, old_text, new_text, cwd),
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
      const cwd = await prepare(ctx.threadId)
      const result = await withAbort(ctx.signal, () => sandbox().grep(pattern, path, cwd), onAbort)
      return { matches: result.matches }
    },
  })

  const bash = defineTool({
    name: 'bash',
    description: 'Run a shell command in the worker worktree',
    input: z.object({
      command: z.string(),
    }),
    handler: async ({ command }, ctx) => {
      const cwd = await prepare(ctx.threadId)
      return await withAbort(ctx.signal, () => sandbox().exec(command, { cwd }), onAbort)
    },
  })

  const gitDiff = defineTool({
    name: 'git_diff',
    description: 'Show the current git diff in the worker worktree',
    input: z.object({}),
    handler: async (_input, ctx) => {
      const cwd = await prepare(ctx.threadId)
      const result = await withAbort(ctx.signal, () => sandbox().gitDiff(cwd), onAbort)
      return { diff: result.diff }
    },
  })

  return { readFile, writeFile, editFile, grep, bash, gitDiff }
}

export function createReadOnlySandboxTools(env: ShuttleEnv, runId: string) {
  const all = createSandboxTools(env, runId)
  return {
    readFile: all.readFile,
    grep: all.grep,
    gitDiff: all.gitDiff,
  }
}
