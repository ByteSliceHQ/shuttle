import { isLocal } from './https'

/** Preview hostnames look like `p3000-<folderId>.preview.example`. */
export function parsePreviewHost(hostname: string): { port: number; folderId: string } | null {
  const match = hostname.match(/^p(\d{2,5})-([a-zA-Z0-9-]+)\./)

  if (match === null) {
    return null
  }

  const port = Number(match[1])
  const folderId = match[2] ?? ''

  if (!Number.isFinite(port) || port < 1 || port > 65535 || folderId === '') {
    return null
  }

  return { port, folderId }
}

/**
 * Whether a hostname is the deployment's own. A deployment that serves previews is routed every
 * name under its domain, and the ones that are neither the app nor a preview are not Shuttle.
 */
export function isOwnHost(hostname: string, webUrl: string | undefined): boolean {
  if (webUrl === undefined || webUrl === '' || isLocal(hostname)) {
    return true
  }

  try {
    return new URL(webUrl).hostname === hostname
  } catch {
    return true
  }
}
