import { ensureContainerRunning, type DurableContainer } from './container-runtime'

const PREVIEW_READY_ATTEMPTS = 15
const PREVIEW_READY_WAIT_MS = 200

function isNotListeningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /container is not listening/i.test(message)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Proxy an HTTP request to a port inside the container via getTcpPort. */
export async function proxyContainerPreview(
  request: Request,
  container: DurableContainer,
  port: number,
): Promise<Response> {
  const running = await ensureContainerRunning(container)
  const fetcher = running.getTcpPort(port)

  // Cloudflare requires host=container when forwarding through getTcpPort.
  const target = new URL(request.url)
  target.protocol = 'http:'
  target.host = 'container'

  let lastError: unknown

  for (let attempt = 0; attempt < PREVIEW_READY_ATTEMPTS; attempt++) {
    const headers = new Headers(request.headers)
    headers.delete('host')

    const forwarded = new Request(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })

    try {
      return await fetcher.fetch(forwarded)
    } catch (error) {
      lastError = error

      if (!isNotListeningError(error) || attempt === PREVIEW_READY_ATTEMPTS - 1) {
        break
      }

      await scheduler.wait(PREVIEW_READY_WAIT_MS)
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')

  return new Response(
    [
      `<!doctype html><meta charset="utf-8"><title>Port ${port} unavailable</title>`,
      `<body style="font-family:system-ui;max-width:36rem;margin:2rem auto;line-height:1.5">`,
      `<h1>Nothing is listening on port ${port}</h1>`,
      `<p>The sandbox container is running, but no process accepted connections on this port.</p>`,
      `<p>If an agent started a server earlier, the container may have restarted — ask it to start the server again (listen on <code>0.0.0.0</code>).</p>`,
      `<pre style="white-space:pre-wrap;opacity:.7">${escapeHtml(detail)}</pre>`,
      `</body>`,
    ].join(''),
    {
      status: 502,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  )
}
