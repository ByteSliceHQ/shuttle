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
}

export async function fetchSandboxPlace(runId: string): Promise<SandboxPlace> {
  const response = await fetch(`${sandboxBase(runId)}/place`)

  if (!response.ok) {
    throw new Error(`Failed to load the sandbox: ${response.status}`)
  }

  return (await response.json()) as SandboxPlace
}

/** The label that leads to a session's sandbox in a preview hostname. Only people who can open
 * the session can ask for it. */
export async function fetchPreviewLabel(runId: string): Promise<string> {
  const response = await fetch(`${sandboxBase(runId)}/preview`)

  if (!response.ok) {
    throw new Error(`Failed to load the preview address: ${response.status}`)
  }

  return ((await response.json()) as { label: string }).label
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

  return `http://p${port}-${sanitizeFolderLabel(folderId)}.${baseHost}${workerPort}`
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
