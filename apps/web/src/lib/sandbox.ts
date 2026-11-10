export interface SandboxFileEntry {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

export interface SandboxFilesResponse {
  readonly root: string
  readonly files: SandboxFileEntry[]
  readonly mode?: 'memory' | 'container'
  readonly error?: string
}

export interface SandboxFileResponse {
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

export interface SandboxDiffResponse {
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

/** Preview host for container ports: `p3000-<folderId>.localhost:8790` locally. */
export function previewUrl(port: number, folderId: string, previewHost?: string): string {
  const host = previewHost ?? `${window.location.hostname.replace(/^www\./, '')}`

  const workerPort = import.meta.env.DEV
    ? ':8790'
    : typeof window !== 'undefined' && window.location.port
      ? `:${window.location.port}`
      : ''

  const baseHost = host.includes('localhost') || host.endsWith('.local') ? 'localhost' : host

  return `http://p${port}-${sanitizeFolderLabel(folderId)}.${baseHost}${workerPort}`
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
