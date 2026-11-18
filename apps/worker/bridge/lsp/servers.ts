import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { LspConnection } from './framing.ts'
import {
  arrayField,
  decodeEach,
  field,
  isNumber,
  isJsonObject,
  isString,
  nonEmpty,
  numberField,
  objectField,
  stringField,
  type JsonValue,
} from './json.ts'
import {
  LSP_DEFAULT_WAIT_MS,
  LSP_SEVERITIES,
  type LspDiagnostic,
  type LspDiagnosticsReply,
  type LspStatusReply,
} from './protocol.ts'
import { resolveServer, SERVERS, type LaunchCommand, type ServerDefinition } from './registry.ts'

/**
 * Running language servers, one per language and project root, started the first time a file
 * of theirs is asked about.
 *
 * Nothing here is an editor: agents change files on disk, through tools and through the shell.
 * So before each answer the pool re-reads every file it has told a server about and sends on
 * whatever changed, which keeps the server's view equal to the disk.
 */

/** How long a server may take to answer `initialize`. */
const INITIALIZE_TIMEOUT_MS = 30_000

/** A server that pushes diagnostics is done once it has been quiet this long. */
const PUSH_QUIET_MS = 300

/** How long to let the file watcher report what was written just before a request arrived. */
const WATCH_SETTLE_MS = 25

/** Directories whose churn no language server needs to hear about one file at a time. */
const UNWATCHED = new Set(['.git', 'node_modules', 'target', 'dist', '.turbo', '.next'])

/** LSP's `FileChangeType`. */
const FILE_CHANGED = 2
const FILE_DELETED = 3

interface Position {
  readonly line?: number
  readonly character?: number
}

interface RawDiagnostic {
  readonly range?: {
    readonly start?: Position
    readonly end?: Position
  }
  readonly severity?: number
  readonly message?: string
  readonly code?: string | number
  readonly source?: string
}

function decodePosition(value: JsonValue | undefined): Position | undefined {
  return isJsonObject(value)
    ? { line: numberField(value, 'line'), character: numberField(value, 'character') }
    : undefined
}

function decodeRawDiagnostic(value: JsonValue): RawDiagnostic | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const range = objectField(value, 'range')
  const code = field(value, 'code')

  return {
    range:
      range === undefined
        ? undefined
        : {
            start: decodePosition(field(range, 'start')),
            end: decodePosition(field(range, 'end')),
          },
    severity: numberField(value, 'severity'),
    message: stringField(value, 'message'),
    code: isString(code) || isNumber(code) ? code : undefined,
    source: stringField(value, 'source'),
  }
}

function decodeRawDiagnostics(value: JsonValue | undefined): RawDiagnostic[] {
  return decodeEach(value, decodeRawDiagnostic)
}

interface SyncResult {
  readonly uri: string
  readonly changed: boolean
}

interface OpenDocument {
  version: number
  text: string
  mtimeMs: number
  /** The server holds an unsaved edit of this file rather than what is on disk. */
  draft: boolean
}

interface Published {
  readonly version: number | undefined
  readonly diagnostics: readonly RawDiagnostic[]
}

function toDiagnostic(raw: RawDiagnostic): LspDiagnostic {
  const line = (raw.range?.start?.line ?? 0) + 1
  const column = (raw.range?.start?.character ?? 0) + 1

  return {
    line,
    column,
    endLine: (raw.range?.end?.line ?? line - 1) + 1,
    endColumn: (raw.range?.end?.character ?? column - 1) + 1,
    severity: LSP_SEVERITIES[(raw.severity ?? 1) - 1] ?? 'error',
    message: raw.message ?? '',
    code: raw.code === undefined ? undefined : String(raw.code),
    source: nonEmpty(raw.source),
  }
}

const PENDING = Symbol('pending')

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(PENDING), ms)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
}

class ServerSession {
  readonly id: string
  readonly root: string
  readonly connection: LspConnection
  readonly ready: Promise<void>
  private readonly documents = new Map<string, OpenDocument>()
  private readonly published = new Map<string, Published>()
  private readonly listeners = new Set<(uri: string) => void>()
  /** Whether the server answers `textDocument/diagnostic`, rather than only pushing. */
  private pulls = false
  /** Files under the root that changed on disk since the server was last told. */
  private readonly touched = new Set<string>()
  private watcher: FSWatcher | null = null

  constructor(id: string, root: string, launch: LaunchCommand) {
    this.id = id
    this.root = root

    const child = spawn(launch.command, [...launch.args], { cwd: root, stdio: 'pipe' })

    // Servers log to stderr. Unread, a full pipe would stall them.
    child.stderr.resume()

    const rootUri = pathToFileURL(root).href
    const folders = [{ uri: rootUri, name: root.split('/').pop() ?? root }]

    const connection = new LspConnection(child, {
      onNotification: (method, params) => {
        const uri = isJsonObject(params) ? stringField(params, 'uri') : undefined

        if (method === 'textDocument/publishDiagnostics' && isJsonObject(params) && uri) {
          this.published.set(uri, {
            version: numberField(params, 'version'),
            diagnostics: decodeRawDiagnostics(field(params, 'diagnostics')),
          })

          for (const listener of this.listeners) {
            listener(uri)
          }
        }
      },
      onRequest: (method, params) => {
        if (method === 'workspace/configuration') {
          // One answer per item asked for. Null means "use your default".
          const items = isJsonObject(params) ? (arrayField(params, 'items') ?? []) : []

          return items.map(() => null)
        }

        return method === 'workspace/workspaceFolders' ? folders : null
      },
    })

    this.connection = connection

    this.ready = (async () => {
      const result = await within(
        connection.request('initialize', {
          processId: process.pid,
          clientInfo: { name: 'shuttle-lsp' },
          rootUri,
          workspaceFolders: folders,
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: { versionSupport: true },
              diagnostic: { dynamicRegistration: false },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
              didChangeWatchedFiles: { dynamicRegistration: true },
            },
          },
        }),
        INITIALIZE_TIMEOUT_MS,
      )

      if (result === PENDING) {
        connection.kill()
        throw new Error(`${id} language server did not start within ${INITIALIZE_TIMEOUT_MS}ms`)
      }

      const capabilities = isJsonObject(result) ? objectField(result, 'capabilities') : undefined
      const provider = capabilities ? field(capabilities, 'diagnosticProvider') : undefined

      this.pulls = provider !== undefined && provider !== null && provider !== false
      connection.notify('initialized', {})
      this.watch()
    })()

    // Reported to whoever awaits `ready`; this only stops an unhandled rejection.
    this.ready.catch(() => {})
  }

  get openFiles(): number {
    return this.documents.size
  }

  /**
   * An editor tells a server when files it has not opened change. Agents change files through
   * the shell, so the daemon watches the project and passes that on.
   */
  private watch(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (name && !name.split(sep).some((part) => UNWATCHED.has(part))) {
          this.touched.add(join(this.root, name))
        }
      })

      this.watcher.on('error', () => {})
    } catch {
      // No watcher: files the server has opened are still kept current by `resync`.
    }
  }

  private flushWatched(): void {
    if (this.touched.size === 0) {
      return
    }

    const changes = [...this.touched].map((path) => ({
      uri: pathToFileURL(path).href,
      type: existsSync(path) ? FILE_CHANGED : FILE_DELETED,
    }))

    this.touched.clear()
    this.connection.notify('workspace/didChangeWatchedFiles', { changes })
  }

  close(): void {
    this.watcher?.close()
    this.connection.kill()
  }

  /**
   * Brings the server's copy of every file it knows up to date with the disk, dropping any
   * unsaved edit it was shown, except for the file `drafting` names.
   */
  private resync(drafting: string | null): void {
    for (const [uri, document] of this.documents) {
      if (uri === drafting) {
        continue
      }

      const path = fileURLToPath(uri)

      try {
        if (document.draft || statSync(path).mtimeMs !== document.mtimeMs) {
          this.sync(path, undefined)
        }
      } catch {
        this.documents.delete(uri)
        this.published.delete(uri)
        this.connection.notify('textDocument/didClose', { textDocument: { uri } })
      }
    }
  }

  /**
   * Tells the server what a file holds now: `draft` when given, otherwise what is on disk.
   * Answers whether that changed anything.
   */
  private sync(file: string, languageId: string | undefined, draft?: string): SyncResult {
    const uri = pathToFileURL(file).href
    const text = draft ?? readFileSync(file, 'utf8')
    const mtimeMs = statSync(file).mtimeMs
    const open = this.documents.get(uri)

    if (!open) {
      this.documents.set(uri, { version: 1, text, mtimeMs, draft: draft !== undefined })

      this.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageId ?? 'plaintext', version: 1, text },
      })

      return { uri, changed: true }
    }

    open.mtimeMs = mtimeMs
    open.draft = draft !== undefined

    if (open.text === text) {
      return { uri, changed: false }
    }

    open.version += 1
    open.text = text
    this.published.delete(uri)

    // The whole text as one change: valid whichever sync kind the server asked for.
    this.connection.notify('textDocument/didChange', {
      textDocument: { uri, version: open.version },
      contentChanges: [{ text }],
    })

    return { uri, changed: true }
  }

  /** Waits for the server to push diagnostics for this version of a file, then for it to go quiet. */
  private pushed(uri: string, version: number): Promise<readonly RawDiagnostic[]> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | null = null

      const settle = () => {
        const latest = this.published.get(uri)

        if (!latest || (latest.version !== undefined && latest.version < version)) {
          return
        }

        if (quiet) {
          clearTimeout(quiet)
        }

        quiet = setTimeout(() => {
          this.listeners.delete(listener)
          resolve(this.published.get(uri)?.diagnostics ?? [])
        }, PUSH_QUIET_MS)
      }

      const listener = (published: string) => {
        if (published === uri) {
          settle()
        }
      }

      this.listeners.add(listener)
      settle()
    })
  }

  async diagnostics(
    file: string,
    languageId: string,
    waitMs: number,
    draft?: string,
  ): Promise<readonly LspDiagnostic[] | typeof PENDING> {
    const deadline = Date.now() + waitMs
    const started = await within(this.ready, waitMs)

    if (started === PENDING) {
      return PENDING
    }

    await new Promise((wake) => setTimeout(wake, WATCH_SETTLE_MS))
    this.flushWatched()
    this.resync(draft === undefined ? null : pathToFileURL(file).href)

    const { uri } = this.sync(file, languageId, draft)
    const version = this.documents.get(uri)?.version ?? 1
    const remaining = Math.max(0, deadline - Date.now())

    const raw = await within(
      this.pulls
        ? this.connection
            .request('textDocument/diagnostic', { textDocument: { uri } })
            .then((report) =>
              decodeRawDiagnostics(isJsonObject(report) ? field(report, 'items') : undefined),
            )
        : this.pushed(uri, version),
      remaining,
    )

    return raw === PENDING ? PENDING : raw.map(toDiagnostic)
  }
}

export class ServerPool {
  private readonly sessions = new Map<string, ServerSession>()
  private readonly definitions: readonly ServerDefinition[]

  constructor(definitions: readonly ServerDefinition[] = SERVERS) {
    this.definitions = definitions
  }

  async diagnostics(
    file: string,
    waitMs = LSP_DEFAULT_WAIT_MS,
    draft?: string,
  ): Promise<LspDiagnosticsReply> {
    const resolved = resolveServer(file, this.definitions)

    if (!resolved) {
      return { status: 'unsupported' }
    }

    const { definition, languageId, root } = resolved
    const key = `${definition.id}\0${root}`
    let session = this.sessions.get(key)

    if (!session) {
      const launch = definition.launch(root)

      if ('unavailable' in launch) {
        return { status: 'unavailable', reason: launch.unavailable }
      }

      const created = new ServerSession(definition.id, root, launch)
      session = created
      this.sessions.set(key, created)

      // A server that exits is started afresh by the next request.
      void created.connection.exited.then(() => {
        created.close()

        if (this.sessions.get(key) === created) {
          this.sessions.delete(key)
        }
      })
    }

    try {
      const diagnostics = await session.diagnostics(file, languageId, waitMs, draft)

      return diagnostics === PENDING
        ? { status: 'pending', server: definition.id }
        : { status: 'ok', server: definition.id, diagnostics }
    } catch (cause) {
      return { status: 'error', reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  status(): LspStatusReply['servers'] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      root: session.root,
      files: session.openFiles,
    }))
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      session.close()
    }

    this.sessions.clear()
  }
}
