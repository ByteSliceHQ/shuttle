import { ensureContainerRunning, type DurableContainer } from './container-runtime'

const PREVIEW_READY_ATTEMPTS = 20
const PREVIEW_READY_WAIT_MS = 250

export function isNotListeningError(error: unknown): boolean {
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

/** Prefer a document error page only when the client asked for HTML. */
export function wantsHtmlErrorPage(request: Request): boolean {
  const dest = request.headers.get('sec-fetch-dest')

  if (dest === 'document' || dest === 'iframe') {
    return true
  }

  if (dest && dest !== 'empty') {
    return false
  }

  const accept = request.headers.get('accept') ?? ''
  return accept.includes('text/html')
}

/**
 * getTcpPort + many upstreams mishandle HEAD (Content-Length without a body,
 * alternating failures). Probe with GET and strip the body for HEAD callers.
 */
export function upstreamMethodFor(request: Request): string {
  return request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method
}

export function asHeadResponse(response: Response): Response {
  void response.body?.cancel()
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function previewUnavailableResponse(
  request: Request,
  port: number,
  detail: string,
): Response {
  const headers = new Headers({
    'retry-after': '2',
    'cache-control': 'no-store',
  })

  if (!wantsHtmlErrorPage(request)) {
    headers.set('content-type', 'text/plain; charset=utf-8')
    return new Response(
      `Port ${port} is not accepting connections in the sandbox container.\n${detail}\n`,
      { status: 503, headers },
    )
  }

  headers.set('content-type', 'text/html; charset=utf-8')

  return new Response(
    [
      `<!doctype html><meta charset="utf-8"><title>Port ${port} unavailable</title>`,
      `<body style="font-family:system-ui;max-width:36rem;margin:2rem auto;line-height:1.5">`,
      `<h1>Nothing is listening on port ${port}</h1>`,
      `<p>The sandbox container is running, but no process accepted connections on this port.</p>`,
      `<p>If an agent started a server earlier, it may have restarted mid-load — reload once the server is listening on <code>0.0.0.0:${port}</code>.</p>`,
      `<pre style="white-space:pre-wrap;opacity:.7">${escapeHtml(detail)}</pre>`,
      `</body>`,
    ].join(''),
    { status: 503, headers },
  )
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

  const method = upstreamMethodFor(request)
  const head = request.method.toUpperCase() === 'HEAD'
  let lastError: unknown

  for (let attempt = 0; attempt < PREVIEW_READY_ATTEMPTS; attempt++) {
    const headers = new Headers(request.headers)
    headers.delete('host')

    const forwarded = new Request(target.toString(), {
      method,
      headers,
      body: method === 'GET' ? undefined : request.body,
      redirect: 'manual',
    })

    try {
      const response = await fetcher.fetch(forwarded)
      return head ? asHeadResponse(response) : response
    } catch (error) {
      lastError = error

      if (!isNotListeningError(error) || attempt === PREVIEW_READY_ATTEMPTS - 1) {
        break
      }

      await scheduler.wait(PREVIEW_READY_WAIT_MS)
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
  return previewUnavailableResponse(request, port, detail)
}
