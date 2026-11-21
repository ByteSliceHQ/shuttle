import { z } from 'zod'

import { ensureContainerRunning, type DurableContainer } from './container-runtime'

const PREVIEW_READY_ATTEMPTS = 20
const PREVIEW_READY_WAIT_MS = 250

export function isNotListeningError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
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

  if (dest !== null && dest !== '' && dest !== 'empty') {
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

/** Marks a response as the page below, so the page can tell when the port starts answering. */
export const PREVIEW_UNAVAILABLE_HEADER = 'x-preview-unavailable'

const UNAVAILABLE_STYLE = [
  ':root{color-scheme:light dark;--bg:#fff;--fg:#18181b;--muted:#6b6b76;--line:#e4e4e7}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0e0e11;--fg:#ededf0;--muted:#9a9aa6;--line:#26262c}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,sans-serif}',
  'main{max-width:26rem;text-align:center}',
  '.port{display:inline-block;margin-bottom:16px;padding:2px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:12px ui-monospace,monospace}',
  'h1{margin:0 0 8px;font-size:17px;font-weight:600;text-wrap:balance}',
  'p{margin:0 0 6px;color:var(--muted);text-wrap:balance}',
  'code{font:12px ui-monospace,monospace;color:var(--fg)}',
  '.wait{margin-top:18px;font-size:12px}',
  '.dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:currentColor;animation:pulse 1.4s ease-in-out infinite}',
  '@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}',
  'pre{margin:16px 0 0;white-space:pre-wrap;text-align:left;color:var(--muted);font:11px ui-monospace,monospace;opacity:.8}',
].join('')

/** Reloads the page once the port stops answering with the page itself. */
const UNAVAILABLE_SCRIPT = [
  '(function(){var t=setInterval(function(){',
  "fetch(location.href,{cache:'no-store',headers:{accept:'text/plain'}}).then(function(r){",
  `if(!r.headers.get('${PREVIEW_UNAVAILABLE_HEADER}')){clearInterval(t);location.reload()}`,
  '}).catch(function(){})},2000)})()',
].join('')

/**
 * What a preview shows when nothing in the sandbox answers on `port`. `detail` is shown as given,
 * so it must not be an upstream's own error text.
 */
export function previewUnavailableResponse(
  request: Request,
  port: number,
  detail?: string,
): Response {
  const hasDetail = detail !== undefined && detail !== ''

  const headers = new Headers({
    'retry-after': '2',
    'cache-control': 'no-store',
    [PREVIEW_UNAVAILABLE_HEADER]: '1',
  })

  if (!wantsHtmlErrorPage(request)) {
    headers.set('content-type', 'text/plain; charset=utf-8')
    return new Response(
      `Port ${port} is not accepting connections in the sandbox.\n${hasDetail ? `${detail}\n` : ''}`,
      { status: 503, headers },
    )
  }

  headers.set('content-type', 'text/html; charset=utf-8')

  return new Response(
    [
      `<!doctype html><html lang="en"><meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width,initial-scale=1">`,
      `<title>Port ${port} unavailable</title><style>${UNAVAILABLE_STYLE}</style>`,
      `<body><main>`,
      `<div class="port">:${port}</div>`,
      `<h1>Nothing is running on port ${port}</h1>`,
      `<p>Start a server on this port in the sandbox and it will show up here.</p>`,
      `<p>If one is already running, make sure it listens on <code>0.0.0.0:${port}</code>.</p>`,
      `<p class="wait"><span class="dot"></span>Waiting for port ${port}</p>`,
      hasDetail ? `<pre>${escapeHtml(detail)}</pre>` : '',
      `</main><script>${UNAVAILABLE_SCRIPT}</script></body></html>`,
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

  const detail =
    lastError instanceof Error ? lastError.message : z.string().catch('unknown').parse(lastError)

  return previewUnavailableResponse(request, port, detail)
}
