import type { JsonValue } from '@swirls/looms/core'

import { jsonFields, jsonText } from '../../../lib/json'
import { worktreeRoot } from '../../../lib/worktree'

/**
 * What a session's event log says about its list of paths. The list only changes when a file is
 * made, deleted or moved; editing a file that is there already leaves it as it was. So most of
 * what agents do needs no new listing:
 *
 * - reading, searching and the session's own tools change nothing;
 * - writing or editing a file names it, so a new one can be added to the list in place;
 * - anything else that runs in the sandbox (a shell command that is not plainly read-only, a
 *   patch that adds or removes files, a tool this does not know, the sandbox moving) may have
 *   changed the tree in ways the log does not say, so the list is read again.
 *
 * A change is counted when its tool finishes, not when it is asked for: a listing read in
 * between would otherwise miss it.
 */

/** An event as the log holds it: its kind, its place in the log and what it carries. */
export interface LoggedEvent {
  readonly type: string
  readonly seq: number
  readonly payload?: JsonValue
}

export interface PathEvents {
  /** Where the latest event that may have changed the tree in an unknown way is in the log. 0 for none. */
  readonly relistSeq: number
  /** Files written by name, relative to the worktree, with where each write is in the log. */
  readonly writes: readonly { readonly seq: number; readonly path: string }[]
}

/** Tools that change no files, Shuttle's own and the vendor agents'. */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'git_diff',
  'share_file',
  'session_status',
  'delegate',
  // A delegated vendor agent's own tool calls are in the log as its own events.
  'delegate_claude',
  'delegate_codex',
  'delegate_cursor',
  'propose_pull_request',
  'propose_lesson',
  'query_events',
  'run_tree',
  'transcript',
  'friction',
  'pr_context',
  'draft_review_comment',
  'submit_review',
  'ask_user',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'read',
  'view',
  'search',
  'web_search',
  'update_plan',
])

/** Tools that write one file, named in their arguments. */
const WRITING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'Write',
  'Edit',
  'MultiEdit',
  'write',
  'edit',
])

const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'exec', 'exec_command'])

/** Events that replace the sandbox's files wholesale. */
const TREE_EVENTS = new Set(['shuttle.sandbox.moved', 'shuttle.sandbox.bound'])

interface PendingCall {
  readonly name: string
  readonly args: Readonly<Record<string, JsonValue>>
}

export function readPathEvents(events: readonly LoggedEvent[], runId: string): PathEvents {
  const calls = new Map<string, PendingCall>()
  const writes: { seq: number; path: string }[] = []
  let relistSeq = 0
  const root = `${worktreeRoot(runId)}/`

  for (const event of events) {
    const payload = jsonFields(event.payload)

    if (TREE_EVENTS.has(event.type)) {
      relistSeq = event.seq
      continue
    }

    if (
      event.type === 'agent.tool_call.requested' ||
      event.type === 'shuttle.vendor.tool_started'
    ) {
      const call = jsonFields(payload.toolCall)
      const id = jsonText(call.id)
      const name = jsonText(call.name)

      if (id !== undefined && name !== undefined) {
        calls.set(id, { name, args: jsonFields(call.arguments) })
      }

      continue
    }

    if (event.type !== 'agent.tool.result' && event.type !== 'shuttle.vendor.tool_finished') {
      continue
    }

    const id = jsonText(payload.toolCallId) ?? ''
    const call = calls.get(id)
    calls.delete(id)

    const name = call?.name ?? jsonText(payload.name) ?? ''
    const failed = (jsonText(payload.error) ?? '') !== ''

    switch (effectOf(name, call?.args ?? {})) {
      case 'none': {
        break
      }

      case 'relist': {
        relistSeq = event.seq
        break
      }

      case 'write': {
        // A write that failed made nothing.
        if (failed) {
          break
        }

        const path = writtenPath(call?.args ?? {}, root)

        if (path === null) {
          relistSeq = event.seq
        } else if (path !== '') {
          writes.push({ seq: event.seq, path })
        }
      }
    }
  }

  return { relistSeq, writes }
}

function effectOf(
  name: string,
  args: Readonly<Record<string, JsonValue>>,
): 'none' | 'write' | 'relist' {
  if (READ_ONLY_TOOLS.has(name)) {
    return 'none'
  }

  if (WRITING_TOOLS.has(name)) {
    return 'write'
  }

  if (SHELL_TOOLS.has(name)) {
    const command = jsonText(args.command) ?? jsonText(args.cmd) ?? ''

    return commandKeepsPaths(command) ? 'none' : 'relist'
  }

  const patch = Object.values(args)
    .map((value) => jsonText(value) ?? '')
    .find((text) => text.includes('*** Begin Patch'))

  if (name === 'apply_patch' || patch !== undefined) {
    return patchKeepsPaths(patch ?? '') ? 'none' : 'relist'
  }

  // A tool this does not know may have changed anything.
  return 'relist'
}

/**
 * The file a writing tool named, relative to the worktree. Null when it named one the list cannot
 * place (a relative path, whose directory is not known); empty when it is outside the worktree.
 */
function writtenPath(args: Readonly<Record<string, JsonValue>>, root: string): string | null {
  const path = jsonText(args.path) ?? jsonText(args.file_path) ?? ''

  if (path === '' || !path.startsWith('/')) {
    return null
  }

  return path.startsWith(root) ? path.slice(root.length) : ''
}

/** Programs that read and never write, at the start of each part of a command line. */
const READ_ONLY_PROGRAMS = new Set([
  'cd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'rg',
  'grep',
  'tree',
  'stat',
  'file',
  'which',
  'sort',
  'uniq',
  'jq',
  'du',
  'df',
  'env',
  'printenv',
  'true',
  'test',
  'diff',
])

/**
 * Git subcommands that leave the working tree's files where they are: reading, and recording or
 * sending what is there. Checking out, resetting, stashing and the like can add or remove files.
 */
const PATH_KEEPING_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'grep',
  'add',
  'commit',
  'push',
  'fetch',
  'config',
  'remote',
  'branch',
  'tag',
])

/**
 * Whether a shell command plainly makes, deletes and moves no files: every part of it, split at
 * `&&`, `||`, `;`, `|` and line breaks, is a program that only reads (or a git command that keeps
 * the tree's files), nothing is redirected into a file, and nothing runs other commands inside it.
 * Anything unclear counts as changing the list.
 */
export function commandKeepsPaths(command: string): boolean {
  if (command.trim() === '' || /[>`]|\$\(|<\(/.test(command)) {
    return false
  }

  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .every((part) => {
      const [program = '', ...rest] = part.split(/\s+/)

      if (program === 'git') {
        return PATH_KEEPING_GIT.has(gitSubcommand(rest))
      }

      if (program === 'find') {
        return !rest.some((word) =>
          ['-delete', '-exec', '-execdir', '-ok', '-fprint'].includes(word),
        )
      }

      if (program === 'sed') {
        return !rest.some((word) => word.startsWith('-i') || word === '--in-place')
      }

      return READ_ONLY_PROGRAMS.has(program)
    })
}

/** Git's global options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The subcommand of a `git` command line: the first word that is not an option or its value. */
function gitSubcommand(words: readonly string[]): string {
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''

    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      at += 1
    } else if (!word.startsWith('-')) {
      return word
    }
  }

  return ''
}

/** Whether a patch only changes files that are there, adding, deleting and moving none. */
function patchKeepsPaths(patch: string): boolean {
  return patch !== '' && !/^\*\*\* (Add File|Delete File|Move to):/m.test(patch)
}

/** The latest place in the log, or 0 for an empty one. */
export function logTail(events: readonly LoggedEvent[]): number {
  return events.at(-1)?.seq ?? 0
}
