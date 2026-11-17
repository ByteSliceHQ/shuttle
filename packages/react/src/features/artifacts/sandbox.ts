import type { QueryClient } from '@tanstack/react-query'

import type {
  ChangeStatus,
  SandboxDiffs,
  SandboxFileDiff,
  SandboxPlace,
  SandboxWorkspaceRepo,
} from '@shuttle/api'

import { type ShuttleHost } from '../../shuttle'

/**
 * The session's sandbox as the page asks about it. What the Worker answers is typed by the
 * contract in `@shuttle/api`; views read it with `api.sandbox.….queryOptions(…)`. Here are the
 * few things every view shares: which reads go stale together, how to tell the two answers of
 * the diff route apart, and the addresses of the terminal and of previews.
 */

export type { ChangeStatus, SandboxPlace }

/** One repository in a session's workspace. Named as the workspace tree knows it. */
export type WorkspaceRepo = SandboxWorkspaceRepo

/**
 * Marks everything read from a session's worktree as out of date: its files, their contents,
 * the changes, and what the language server said. Views that are showing any of it read again;
 * the rest do when they are next shown.
 */
export function invalidateWorktree(
  { api }: ShuttleHost,
  queries: QueryClient,
  runId: string,
): Promise<void> {
  const input = { id: runId }

  return Promise.all([
    queries.invalidateQueries({ queryKey: api.sandbox.workspace.key({ input }) }),
    queries.invalidateQueries({ queryKey: api.sandbox.files.key({ input }) }),
    queries.invalidateQueries({ queryKey: api.sandbox.file.key({ input }) }),
    queries.invalidateQueries({ queryKey: api.sandbox.diff.key({ input }) }),
    queries.invalidateQueries({ queryKey: api.sandbox.diagnostics.saved.key({ input }) }),
  ]).then(() => {})
}

/**
 * The diff route answers with one file's changes when asked about a file, and with every
 * repository's otherwise. This is the patch either way: the file's, or all of them joined.
 */
export function patchOf(answer: SandboxFileDiff | SandboxDiffs): string {
  return 'diffs' in answer ? answer.diffs.map((entry) => entry.diff).join('\n') : answer.diff
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

export function sandboxTerminalUrl(
  host: ShuttleHost,
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

  return host.socketUrl(`${sandboxBase(identity.runId)}/terminal${query}`)
}

/** Where previews are served from: the backend, and the port when previews have their own. */
export type PreviewBackend = Pick<ShuttleHost, 'origin' | 'previewPort'>

/**
 * Preview host for sandbox ports: `p3000-<label>.localhost:8790` locally. Previews are
 * subdomains of the backend, which is the page's own origin unless `backend` says otherwise.
 */
export function previewUrl(
  port: number,
  folderId: string,
  previewHost?: string,
  backend?: PreviewBackend,
): string {
  const at = backend
    ? new URL(backend.origin())
    : typeof window !== 'undefined'
      ? window.location
      : undefined

  const host = previewHost ?? `${at?.hostname.replace(/^www\./, '') ?? ''}`

  const workerPort = backend?.previewPort
    ? `:${backend.previewPort}`
    : at?.port
      ? `:${at.port}`
      : ''

  // A preview needs a subdomain, which an IP address cannot have. Loopback addresses map to
  // `localhost`, whose subdomains browsers resolve to the same machine.
  const loopback = host.includes('localhost') || host.endsWith('.local') || isLoopbackAddress(host)
  const baseHost = loopback ? 'localhost' : host

  // A page served over https cannot frame an http one, and a deployment only answers https.
  const secure = !loopback && at?.protocol === 'https:'

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
  backend?: PreviewBackend,
): string {
  const trimmed = target.trim()

  if (!trimmed) {
    return ''
  }

  const loopbackPort = loopbackPreviewPort(trimmed)

  if (loopbackPort != null && folderId) {
    return previewUrl(loopbackPort, folderId, previewHost, backend)
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith('//')) {
    return `http:${trimmed}`
  }

  return `http://${trimmed}`
}
