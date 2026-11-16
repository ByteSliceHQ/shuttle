/**
 * Keeping a deployment on https.
 *
 * Cloudflare answers plain http on a custom domain unless the zone is told otherwise, so the
 * Worker sends those requests to https itself, and tells browsers to come straight to https
 * from then on. A development server on this machine is left alone.
 */

/** A development server on this machine. */
export function isLocal(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}

/** Where a plain http request should go instead. Null when the request is fine as it is. */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url)

  if (url.protocol !== 'http:' || isLocal(url.hostname)) {
    return null
  }

  url.protocol = 'https:'

  return Response.redirect(url.toString(), 301)
}

/** A year, for this host only: preview hosts under the same domain make their own choice. */
const HSTS = 'max-age=31536000'

/** The same response, telling the browser to use https for this host from now on. */
export function withHsts(request: Request, response: Response): Response {
  if (isLocal(new URL(request.url).hostname) || response.status === 101) {
    return response
  }

  const secured = new Response(response.body, response)

  secured.headers.set('strict-transport-security', HSTS)

  return secured
}
