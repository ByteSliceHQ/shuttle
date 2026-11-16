/**
 * Serving the web app from the Worker, so Shuttle is one origin: the page, the API it calls and
 * the sign-in cookie between them. A deployment built with `bun run deploy` has the web app's
 * files bound as `WEB`; local development has no such binding and Vite serves the page instead,
 * proxying the same paths here (see `apps/web/vite.config.ts`, which this mirrors).
 */

/** Paths the Worker answers itself. */
const API_PREFIXES = [
  '/definitions',
  '/health',
  '/operations',
  '/runs',
  '/sessions',
  '/playbook',
  '/workspace',
  '/firehose',
  '/runners',
  '/github',
  '/api/auth',
  '/auth',
  '/me',
]

/** API paths that are never a page: GitHub's redirects and sign-in callbacks land on these. */
const NEVER_A_PAGE = ['/github', '/api/auth']

function under(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Whether a request is for the web app and not for the API. `/sessions/<id>` and `/playbook`
 * are both: a page when a browser navigates to them, the API when the page fetches them.
 */
export function isWebAppRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }

  const { pathname } = new URL(request.url)

  if (!under(pathname, API_PREFIXES)) {
    return true
  }

  return (
    !under(pathname, NEVER_A_PAGE) &&
    request.headers.get('upgrade') === null &&
    (request.headers.get('accept') ?? '').includes('text/html')
  )
}
