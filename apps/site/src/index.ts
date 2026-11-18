/**
 * shuttle.codes. The page is static (`public/`); this Worker only hands out the desktop app.
 *
 *   GET /download/mac          → the current Mac build
 *   GET /download/<file name>  → that build, from the `shuttle-releases` bucket
 */

import { httpsRedirect, withHsts } from './https'

export interface SiteEnv {
  readonly ASSETS: Fetcher
  readonly RELEASES: R2Bucket
  readonly LATEST_MAC: string
}

/** A build's file name: nothing that could reach outside the bucket's top level. */
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(dmg|zip|exe|AppImage|blockmap)$/

export function releaseName(pathname: string): string | null {
  const name = pathname.slice('/download/'.length)

  return name === 'latest-mac.json' || name === 'latest-mac.yml' || RELEASE_NAME.test(name)
    ? name
    : null
}

function releaseHeaders(object: R2Object, name: string): Headers {
  const headers = new Headers()

  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('content-disposition', `attachment; filename="${name}"`)

  // A build never changes under its name; a new one gets a new name.
  headers.set(
    'cache-control',
    name.startsWith('latest-mac.') ? 'no-store' : 'public, max-age=86400',
  )

  return headers
}

async function download(request: Request, env: SiteEnv, name: string): Promise<Response> {
  // A HEAD asks only for the headers; reading the body of a large build would waste the read.
  if (request.method === 'HEAD') {
    const object = await env.RELEASES.head(name)

    if (!object) {
      return new Response(null, { status: 404 })
    }

    const headers = releaseHeaders(object, name)
    headers.set('content-length', String(object.size))

    return new Response(null, { headers })
  }

  const object = await env.RELEASES.get(name, { range: request.headers, onlyIf: request.headers })

  if (!object) {
    return new Response('No such download.', { status: 404 })
  }

  const headers = releaseHeaders(object, name)

  if (!('body' in object)) {
    return new Response(null, { status: 304, headers })
  }

  const { range } = object

  if (range && 'offset' in range && request.headers.has('range')) {
    const offset = range.offset ?? 0
    const length = range.length ?? object.size - offset

    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    headers.set('content-length', String(length))

    return new Response(object.body, { status: 206, headers })
  }

  headers.set('content-length', String(object.size))

  return new Response(object.body, { headers })
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const secure = httpsRedirect(request)

    if (secure) {
      return secure
    }

    const url = new URL(request.url)

    if (url.pathname === '/download/mac') {
      // The manual download also advances for ad hoc builds that cannot auto-install.
      const pointer = await env.RELEASES.get('latest-mac.json')
      const data = pointer ? await pointer.json<{ file?: unknown }>().catch(() => null) : null

      const name =
        typeof data?.file === 'string' && /^Shuttle-[A-Za-z0-9._-]+\.dmg$/.test(data.file)
          ? data.file
          : env.LATEST_MAC

      return Response.redirect(new URL(`/download/${name}`, url).toString(), 302)
    }

    if (url.pathname.startsWith('/download/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed.', { status: 405 })
      }

      const name = releaseName(url.pathname)

      return name
        ? download(request, env, name)
        : new Response('No such download.', { status: 404 })
    }

    return withHsts(request, await env.ASSETS.fetch(request))
  },
} satisfies ExportedHandler<SiteEnv>
