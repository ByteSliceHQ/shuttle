import { cachedFetch, peekCached, putCached } from './cached'

export interface SandboxFileEntry {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/**
 * Where a tab's contents came from: the running `sandbox`, the session's work as last `saved`
 * while its sandbox sleeps, or nowhere because the sandbox is `asleep` with nothing saved.
 */
export interface SandboxSource {
  readonly source?: 'sandbox' | 'saved' | 'asleep'
  /** When the saved copy was saved, in milliseconds. */
  readonly savedAt?: number | null
}

export interface SandboxFilesResponse extends SandboxSource {
  readonly root: string
  readonly files: SandboxFileEntry[]
  readonly mode?: 'memory' | 'container'
  readonly error?: string
}

export interface SandboxFileResponse extends SandboxSource {
  readonly path: string
  readonly content: string
  readonly binary?: boolean
  readonly truncated?: boolean
}

export interface SandboxDiffEntry {
  readonly cwd: string
  readonly name: string
  readonly diff: string
}

export interface SandboxDiffResponse extends SandboxSource {
  readonly diffs: SandboxDiffEntry[]
}

/** How a file differs from where the session started: added, modified or deleted. */
export type ChangeStatus = 'A' | 'M' | 'D'

/** One repository in a session's workspace. */
export interface WorkspaceRepo {
  /** Its directory in the workspace. */
  readonly name: string
  /** Its name on GitHub. Null for the scratch repository of a folder with none linked. */
  readonly fullName: string | null
  /** The branch its changes are measured from. */
  readonly defaultBranch: string
  /** Every file, relative to the repository. */
  readonly files: readonly string[]
  readonly changes: readonly { readonly path: string; readonly status: ChangeStatus }[]
}

/** A session's workspace: its repositories, what changed in each, and where it was read from. */
export interface WorkspaceResponse extends SandboxSource {
  /** Whether agents are working in the session right now. People edit between turns. */
  readonly working?: boolean
  /** Whose sandbox holds the workspace, where each person has one. Null otherwise. */
  readonly holderId?: string | null
  readonly repos: readonly WorkspaceRepo[]
  /** Things written under /workspace but outside the session's workspace. */
  readonly strays: readonly { readonly path: string; readonly files: number }[]
  readonly error?: string
}

export interface SandboxIdentity {
  readonly runId: string
  readonly folderId?: string
}

function sandboxQuery(identity: SandboxIdentity, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra)

  if (identity.folderId) {
    params.set('folderId', identity.folderId)
  }

  const query = params.toString()
  return query ? `?${query}` : ''
}

function sandboxBase(runId: string): string {
  return `/sessions/${encodeURIComponent(runId)}/sandbox`
}

export async function fetchSandboxFiles(identity: SandboxIdentity): Promise<SandboxFilesResponse> {
  const response = await fetch(`${sandboxBase(identity.runId)}/files${sandboxQuery(identity)}`)
  const body = (await response.json()) as SandboxFilesResponse

  if (!response.ok) {
    throw new Error(body.error ?? `Failed to list files: ${response.status}`)
  }

  if (body.error) {
    throw new Error(body.error)
  }

  return body
}

export async function fetchSandboxFile(
  identity: SandboxIdentity,
  path: string,
): Promise<SandboxFileResponse> {
  const response = await fetch(
    `${sandboxBase(identity.runId)}/file${sandboxQuery(identity, { path })}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to read file: ${response.status}`)
  }

  return (await response.json()) as SandboxFileResponse
}

export async function fetchSandboxDiff(identity: SandboxIdentity): Promise<SandboxDiffResponse> {
  const response = await fetch(`${sandboxBase(identity.runId)}/diff${sandboxQuery(identity)}`)

  if (!response.ok) {
    throw new Error(`Failed to load diff: ${response.status}`)
  }

  return (await response.json()) as SandboxDiffResponse
}

export async function fetchWorkspace(runId: string): Promise<WorkspaceResponse> {
  const response = await fetch(`${sandboxBase(runId)}/workspace`)
  const body = (await response.json()) as WorkspaceResponse

  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Failed to load the workspace: ${response.status}`)
  }

  return body
}

/** One file's changes since the session started. `path` is `<repository>/<path>`. */
export async function fetchFileDiff(runId: string, path: string): Promise<string> {
  const response = await fetch(`${sandboxBase(runId)}/diff?${new URLSearchParams({ path })}`)

  if (!response.ok) {
    throw new Error(`Failed to load changes: ${response.status}`)
  }

  return ((await response.json()) as { diff: string }).diff
}

/**
 * One file as it was when the session started. `content` is null when it did not exist then.
 * The whole answer is null when that is not known, which is the case for older saved copies.
 */
export async function fetchBaseFile(
  runId: string,
  path: string,
): Promise<{ content: string | null } | null> {
  const response = await fetch(
    `${sandboxBase(runId)}/file?${new URLSearchParams({ path, version: 'base' })}`,
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to read the file: ${response.status}`)
  }

  return { content: ((await response.json()) as { content: string | null }).content }
}

/**
 * Saves an edit to a file in the workspace. `expected` is the text the edit started from; the
 * save is refused if the file has changed since, and while agents are working.
 */
export async function saveFile(
  runId: string,
  path: string,
  content: string,
  expected: string,
): Promise<void> {
  const response = await fetch(`${sandboxBase(runId)}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, expected }),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null

    throw new Error(body?.error ?? `Could not save: ${response.status}`)
  }
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

/** One problem the language server found. Positions are 1-based, as an editor shows them. */
export interface FileDiagnostic {
  readonly line: number
  readonly column: number
  readonly endLine: number
  /** The column after the problem's last character. */
  readonly endColumn: number
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly code?: string
  readonly source?: string
}

export type FileDiagnostics =
  | {
      readonly status: 'ok'
      readonly server: string
      readonly diagnostics: readonly FileDiagnostic[]
    }
  /** The server is still starting. Asking again shortly will answer. */
  | { readonly status: 'pending' }
  /** No server covers this kind of file, or this sandbox cannot run one. */
  | { readonly status: 'unsupported' | 'unavailable' | 'error'; readonly reason?: string }

/**
 * What the sandbox's language server says about a file: as saved, or, given `draft`, as someone
 * is editing it. `path` is `<repository>/<path>`.
 */
export async function fetchDiagnostics(
  runId: string,
  path: string,
  draft?: string,
  signal?: AbortSignal,
): Promise<FileDiagnostics> {
  const response = await fetch(
    `${sandboxBase(runId)}/diagnostics?path=${encodeURIComponent(path)}`,
    {
      signal,
      ...(draft === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: draft }),
          }),
    },
  )

  if (!response.ok) {
    return { status: 'error', reason: `Could not check the file: ${response.status}` }
  }

  return (await response.json()) as FileDiagnostics
}

/** Moves something an agent wrote outside the workspace into it. */
export async function adoptStray(runId: string, path: string): Promise<void> {
  const response = await fetch(`${sandboxBase(runId)}/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null

    throw new Error(body?.error ?? `Could not move it: ${response.status}`)
  }
}

export function sandboxTerminalUrl(
  identity: SandboxIdentity,
  options: { cwd?: string; cols?: number; rows?: number },
): string {
  const params: Record<string, string> = {}

  if (options.cwd) {
    params.cwd = options.cwd
  }

  if (options.cols) {
    params.cols = String(options.cols)
  }

  if (options.rows) {
    params.rows = String(options.rows)
  }

  const query = sandboxQuery(identity, params)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host

  return `${protocol}//${host}${sandboxBase(identity.runId)}/terminal${query}`
}

/** Whose sandbox holds a session's files, as it bears on a terminal the viewer opens. */
export interface SandboxPlace {
  /** Whether each person has a sandbox of their own. */
  readonly personal: boolean
  /** The person whose sandbox holds the session's files. Null when unknown or not personal. */
  readonly holderId: string | null
  /** Whether the session's files are in the sandbox the viewer's terminal opens in. */
  readonly here: boolean
  /** The sandbox that holds the session's files. */
  readonly sandbox: {
    readonly provider: string
    readonly location: 'local' | 'cloud'
    readonly deviceId?: string | null
    /** For a sandbox on someone's machine: whether that machine is connected. */
    readonly online?: boolean
    readonly device?: { readonly id: string; readonly name: string; readonly platform: string }
    readonly backend?: { readonly id: string; readonly label: string; readonly isolation: string }
  }
  /** Where a move that is waiting for the session to stop working will take it. */
  readonly pending: 'local' | 'cloud' | null
  /** Set when the session last left a machine that was not connected, from its last save. */
  readonly leftBehind: { readonly deviceId: string | null; readonly at: number } | null
  /** Set while the session is placed on a person's own machine. */
  readonly local: { readonly deviceId: string; readonly mine: boolean } | null
  readonly cloud: { readonly provider: string; readonly movable: boolean }
}

/** A machine's sandbox, as `GET /runners/<deviceId>` describes it. */
export interface LocalMachine {
  readonly online: boolean
  readonly device?: { readonly id: string; readonly name: string; readonly platform: string }
  readonly backend?: { readonly id: string; readonly label: string; readonly isolation: string }
}

export async function fetchLocalMachine(deviceId: string): Promise<LocalMachine> {
  const response = await fetch(`/runners/${encodeURIComponent(deviceId)}`)

  if (!response.ok) {
    throw new Error(`Failed to load this machine's sandbox: ${response.status}`)
  }

  return (await response.json()) as LocalMachine
}

/** Moves a session, with its work, to one of the viewer's machines or back to the cloud. */
export async function moveSession(
  runId: string,
  to: { readonly to: 'local'; readonly deviceId: string } | { readonly to: 'cloud' },
): Promise<SandboxPlace> {
  const response = await fetch(`${sandboxBase(runId)}/place`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(to),
  })

  const body = (await response.json().catch(() => null)) as
    | (SandboxPlace & { error?: undefined })
    | { error: string }
    | null

  if (!response.ok || !body || body.error !== undefined) {
    throw new Error(body?.error ?? `Could not move the session: ${response.status}`)
  }

  return putCached(`place:${runId}`, body)
}

/** Where the session was when last asked, for a view to start from while it asks again. */
export function peekSandboxPlace(runId: string): SandboxPlace | undefined {
  return peekCached<SandboxPlace>(`place:${runId}`)
}

export function fetchSandboxPlace(runId: string): Promise<SandboxPlace> {
  return cachedFetch(`place:${runId}`, () => loadSandboxPlace(runId))
}

async function loadSandboxPlace(runId: string): Promise<SandboxPlace> {
  const response = await fetch(`${sandboxBase(runId)}/place`)

  if (!response.ok) {
    throw new Error(`Failed to load the sandbox: ${response.status}`)
  }

  return (await response.json()) as SandboxPlace
}

/** Where a session's previews are served. */
export interface PreviewAddress {
  /** The label that leads to the session's sandbox in a preview hostname. */
  readonly label: string
  /** The domain previews hang off, when the deployment names one. */
  readonly host?: string
}

/** Only people who can open the session can ask for its preview address. */
export async function fetchPreviewAddress(runId: string): Promise<PreviewAddress> {
  const response = await fetch(`${sandboxBase(runId)}/preview`)

  if (!response.ok) {
    throw new Error(`Failed to load the preview address: ${response.status}`)
  }

  const { label, host } = (await response.json()) as { label: string; host?: string }

  return { label, ...(host ? { host } : {}) }
}

/** Preview host for sandbox ports: `p3000-<label>.localhost:8790` locally. */
export function previewUrl(port: number, folderId: string, previewHost?: string): string {
  const host = previewHost ?? `${window.location.hostname.replace(/^www\./, '')}`

  const workerPort = import.meta.env.DEV
    ? `:${import.meta.env.VITE_SHUTTLE_WORKER_PORT ?? '8790'}`
    : typeof window !== 'undefined' && window.location.port
      ? `:${window.location.port}`
      : ''

  // A preview needs a subdomain, which an IP address cannot have. Loopback addresses map to
  // `localhost`, whose subdomains browsers resolve to the same machine.
  const loopback = host.includes('localhost') || host.endsWith('.local') || isLoopbackAddress(host)
  const baseHost = loopback ? 'localhost' : host

  // A page served over https cannot frame an http one, and a deployment only answers https.
  const secure = !loopback && typeof window !== 'undefined' && window.location.protocol === 'https:'

  return `${secure ? 'https' : 'http'}://p${port}-${sanitizeFolderLabel(folderId)}.${baseHost}${workerPort}`
}

function isLoopbackAddress(host: string): boolean {
  return (
    /^127(\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0' || host === '[::1]' || host === '::1'
  )
}

export function sanitizeFolderLabel(folderId: string): string {
  return folderId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48) || 'folder'
}

/** Extract a localhost / loopback port for sandbox preview rewriting. */
export function loopbackPreviewPort(target: string): number | null {
  const trimmed = target.trim()

  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed)
    return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : null
  }

  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(?:[/?#]|$)/i,
  )

  if (!match) {
    return null
  }

  const port = match[1] ? Number(match[1]) : 80
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : null
}

export function resolveBrowserTarget(
  target: string,
  folderId: string | undefined,
  previewHost?: string,
): string {
  const trimmed = target.trim()

  if (!trimmed) {
    return ''
  }

  const loopbackPort = loopbackPreviewPort(trimmed)

  if (loopbackPort != null && folderId) {
    return previewUrl(loopbackPort, folderId, previewHost)
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith('//')) {
    return `http:${trimmed}`
  }

  return `http://${trimmed}`
}
