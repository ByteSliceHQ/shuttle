/** Preview hostnames look like `p3000-<folderId>.preview.example`. */
export function parsePreviewHost(hostname: string): { port: number; folderId: string } | null {
  const match = hostname.match(/^p(\d{2,5})-([a-zA-Z0-9-]+)\./)

  if (!match) {
    return null
  }

  const port = Number(match[1])
  const folderId = match[2] ?? ''

  if (!Number.isFinite(port) || port < 1 || port > 65535 || !folderId) {
    return null
  }

  return { port, folderId }
}
