/**
 * What `shuttle-lsp` and the Worker say to each other. Nothing here touches Node, so the Worker
 * can import it.
 */

/** Path of the `shuttle-lsp` entry point inside the sandbox. */
export const LSP_CLI_PATH = '/opt/shuttle-bridge/lsp/cli.ts'

/** How long a diagnostics request waits for the language server before answering `pending`. */
export const LSP_DEFAULT_WAIT_MS = 8000

/** Most problems a tool result carries. A file with more says how many were left out. */
export const LSP_MAX_TOOL_DIAGNOSTICS = 20

export type LspSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface LspDiagnostic {
  /** 1-based, as an editor shows it. */
  readonly line: number
  /** 1-based, as an editor shows it. */
  readonly column: number
  /** Where the problem ends, 1-based. The column is the one after its last character. */
  readonly endLine: number
  readonly endColumn: number
  readonly severity: LspSeverity
  readonly message: string
  readonly code?: string
  readonly source?: string
}

export type LspDiagnosticsReply =
  /** The server checked the file as it is on disk. */
  | {
      readonly status: 'ok'
      readonly server: string
      readonly diagnostics: readonly LspDiagnostic[]
    }
  /** The server is still starting or indexing. Asking again later will answer. */
  | { readonly status: 'pending'; readonly server: string }
  /** No language server is registered for this kind of file. */
  | { readonly status: 'unsupported' }
  /** A server is registered but cannot run here, and why. */
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }

export type LspRequest =
  | {
      readonly op: 'diagnostics'
      readonly file: string
      readonly waitMs?: number
      /**
       * The file's text as someone is editing it, not yet saved. Checked in place of what is on
       * disk, and forgotten the next time anything is asked without it.
       */
      readonly text?: string
    }
  | { readonly op: 'status' }
  | { readonly op: 'stop' }

export interface LspStatusReply {
  readonly status: 'ok'
  readonly pid: number
  readonly servers: readonly {
    readonly id: string
    readonly root: string
    readonly files: number
  }[]
}

/** What a write or edit tool adds to its result about the file it just changed. */
export interface ToolDiagnostics {
  /** One line per problem: `12:5 error TS2322: Type 'string' is not assignable to type 'number'.` */
  readonly diagnostics?: readonly string[]
  /** Problems beyond the ones listed. */
  readonly diagnostics_omitted?: number
  /** Set when the language server had not finished checking in time. */
  readonly diagnostics_pending?: true
}

export function formatDiagnostic(diagnostic: LspDiagnostic): string {
  const code = diagnostic.code
    ? ` ${/^\d+$/.test(diagnostic.code) && (diagnostic.source === 'ts' || diagnostic.source === 'typescript') ? 'TS' : ''}${diagnostic.code}`
    : ''

  return `${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code}: ${diagnostic.message}`
}

/**
 * Turns what `shuttle-lsp diagnostics` printed into what a tool tells the agent. Answers nothing
 * when there is nothing worth saying: no server for the file, no `shuttle-lsp` in this sandbox,
 * or output that is not a reply at all.
 */
export function toolDiagnostics(stdout: string): ToolDiagnostics {
  let reply: LspDiagnosticsReply

  try {
    reply = JSON.parse(stdout.trim()) as LspDiagnosticsReply
  } catch {
    return {}
  }

  if (typeof reply !== 'object' || reply === null) {
    return {}
  }

  if (reply.status === 'pending') {
    return { diagnostics_pending: true }
  }

  if (reply.status !== 'ok' || !Array.isArray(reply.diagnostics)) {
    return {}
  }

  // Hints and suggestions are noise to an agent that only asked to change a file.
  const problems = reply.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning',
  )

  const shown = problems.slice(0, LSP_MAX_TOOL_DIAGNOSTICS)

  return {
    diagnostics: shown.map(formatDiagnostic),
    ...(problems.length > shown.length
      ? { diagnostics_omitted: problems.length - shown.length }
      : {}),
  }
}
