/**
 * What `shuttle-lsp` and the Worker say to each other. Nothing here touches Node, so the Worker
 * can import it. It decodes with hand-written guards from `json.ts`, not a schema library,
 * because the daemon runs in sandboxes where no `node_modules` exist.
 */
import {
  arrayField,
  decodeEach,
  field,
  isJsonObject,
  numberField,
  parseJson,
  stringField,
  type JsonValue,
} from './json.ts'

/** Path of the `shuttle-lsp` entry point inside the sandbox. */
export const LSP_CLI_PATH = '/opt/shuttle-bridge/lsp/cli.ts'

/** How long a diagnostics request waits for the language server before answering `pending`. */
export const LSP_DEFAULT_WAIT_MS = 8000

/** Most problems a tool result carries. A file with more says how many were left out. */
export const LSP_MAX_TOOL_DIAGNOSTICS = 20

/** LSP's severities in the order its numbers 1 to 4 give them. */
export const LSP_SEVERITIES = ['error', 'warning', 'info', 'hint'] as const

export type LspSeverity = (typeof LSP_SEVERITIES)[number]

function isLspSeverity(value: string | undefined): value is LspSeverity {
  return LSP_SEVERITIES.some((severity) => severity === value)
}

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

export interface LspServerStatus {
  readonly id: string
  readonly root: string
  readonly files: number
}

export interface LspStatusReply {
  readonly status: 'ok'
  readonly pid: number
  readonly servers: readonly LspServerStatus[]
}

export interface LspStopReply {
  readonly status: 'ok'
}

/** Whatever the daemon answers a request with. */
export type LspReply = LspDiagnosticsReply | LspStatusReply | LspStopReply

function decodeDiagnostic(value: JsonValue): LspDiagnostic | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const line = numberField(value, 'line')
  const column = numberField(value, 'column')
  const severity = stringField(value, 'severity')
  const message = stringField(value, 'message')

  if (
    line === undefined ||
    column === undefined ||
    !isLspSeverity(severity) ||
    message === undefined
  ) {
    return undefined
  }

  return {
    line,
    column,
    endLine: numberField(value, 'endLine') ?? line,
    endColumn: numberField(value, 'endColumn') ?? column,
    severity,
    message,
    code: stringField(value, 'code'),
    source: stringField(value, 'source'),
  }
}

/** A reply to a diagnostics request, or undefined when `value` is not one. */
export function decodeDiagnosticsReply(
  value: JsonValue | undefined,
): LspDiagnosticsReply | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const server = stringField(value, 'server') ?? ''
  const reason = stringField(value, 'reason') ?? ''

  switch (stringField(value, 'status')) {
    case 'ok': {
      const diagnostics = arrayField(value, 'diagnostics')

      return diagnostics === undefined
        ? undefined
        : { status: 'ok', server, diagnostics: decodeEach(diagnostics, decodeDiagnostic) }
    }

    case 'pending': {
      return { status: 'pending', server }
    }

    case 'unsupported': {
      return { status: 'unsupported' }
    }

    case 'unavailable': {
      return { status: 'unavailable', reason }
    }

    case 'error': {
      return { status: 'error', reason }
    }

    case undefined:

    default: {
      return undefined
    }
  }
}

function decodeServerStatus(value: JsonValue): LspServerStatus | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const id = stringField(value, 'id')
  const root = stringField(value, 'root')
  const files = numberField(value, 'files')

  return id === undefined || root === undefined || files === undefined
    ? undefined
    : { id, root, files }
}

/** A reply to a status request, or undefined when `value` is not one. */
export function decodeStatusReply(value: JsonValue | undefined): LspStatusReply | undefined {
  if (!isJsonObject(value) || stringField(value, 'status') !== 'ok') {
    return undefined
  }

  const pid = numberField(value, 'pid')

  return pid === undefined
    ? undefined
    : { status: 'ok', pid, servers: decodeEach(field(value, 'servers'), decodeServerStatus) }
}

/** A request on the daemon's socket, or undefined when `value` is not one. */
export function decodeLspRequest(value: JsonValue | undefined): LspRequest | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const file = stringField(value, 'file')

  switch (stringField(value, 'op')) {
    case 'diagnostics': {
      return file === undefined
        ? undefined
        : {
            op: 'diagnostics',
            file,
            waitMs: numberField(value, 'waitMs'),
            text: stringField(value, 'text'),
          }
    }

    case 'status': {
      return { op: 'status' }
    }

    case 'stop': {
      return { op: 'stop' }
    }

    case undefined:

    default: {
      return undefined
    }
  }
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
  const reply = decodeDiagnosticsReply(parseJson(stdout.trim()))

  if (reply === undefined) {
    return {}
  }

  if (reply.status === 'pending') {
    return { diagnostics_pending: true }
  }

  if (reply.status !== 'ok') {
    return {}
  }

  // Hints and suggestions are noise to an agent that only asked to change a file.
  const problems = reply.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning',
  )

  const shown = problems.slice(0, LSP_MAX_TOOL_DIAGNOSTICS)
  const lines = shown.map(formatDiagnostic)

  if (problems.length > shown.length) {
    return { diagnostics: lines, diagnostics_omitted: problems.length - shown.length }
  }

  return { diagnostics: lines }
}
