import {
  MAX_ASSET_BYTES,
  assetKind,
  cleanAssetName,
  formatBytes,
  getAsset,
  putAsset,
  uploadMediaType,
} from '../assets/store'
import type { ShuttleEnv } from '../env'
import type { Actor } from '../tenancy/access'

const UNAVAILABLE = 'File storage is not set up for this Shuttle, so files cannot be attached.'

/**
 * A session's media.
 *
 *   POST /sessions/:id/assets?name=<file name>    the file as the request body, its type in
 *                                                 content-type; replies { asset }
 *   GET  /sessions/:id/assets/:assetId            the file, with range requests for seeking
 *
 * `index.ts` has already checked that `actor` may open the session the path names, and every
 * asset is stored under its session, so one session can never read another's files.
 */
export async function handleAssetRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/assets(?:\/([^/]+))?$/)

  if (!match) {
    return null
  }

  const runId = decodeURIComponent(match[1] ?? '')
  const rawAssetId = match[2]

  const assetId =
    rawAssetId !== undefined && rawAssetId !== '' ? decodeURIComponent(rawAssetId) : null

  if (!env.ASSETS) {
    return Response.json({ error: UNAVAILABLE }, { status: 503 })
  }

  if (assetId === null && request.method === 'POST') {
    return uploadAsset(request, env.ASSETS, actor, runId, url.searchParams.get('name') ?? '')
  }

  if (assetId !== null && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveAsset(request, env.ASSETS, runId, assetId, url.searchParams.has('download'))
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

async function uploadAsset(
  request: Request,
  bucket: R2Bucket,
  actor: Actor,
  runId: string,
  rawName: string,
): Promise<Response> {
  const name = cleanAssetName(rawName)
  const length = request.headers.get('content-length')
  // An upload sent in chunks declares no length; only a declared one can be checked up front.
  const declared = length === null ? Number.NaN : Number(length)
  const tooLarge = `Files can be up to ${formatBytes(MAX_ASSET_BYTES)}.`

  if (!request.body || declared === 0) {
    return Response.json({ error: 'The file is empty.' }, { status: 400 })
  }

  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    return Response.json({ error: tooLarge }, { status: 413 })
  }

  // R2 needs a body of known length, and a declared length cannot be trusted to be the real
  // one, so the body is read here with the limit enforced as it arrives.
  const body = await readCapped(request.body, MAX_ASSET_BYTES)

  if (body === null) {
    return Response.json({ error: tooLarge }, { status: 413 })
  }

  if (body.byteLength === 0) {
    return Response.json({ error: 'The file is empty.' }, { status: 400 })
  }

  const mediaType = uploadMediaType(request.headers.get('content-type'), name)

  const asset = await putAsset(bucket, runId, {
    name,
    mediaType,
    body,
    source: 'upload',
    createdBy: actor.userId,
  })

  return Response.json({ asset }, { status: 201 })
}

async function readCapped(stream: ReadableStream, limit: number) {
  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('request body chunk is not bytes')
    }

    total += chunk.byteLength

    if (total > limit) {
      return null
    }

    chunks.push(chunk)
  }

  const body = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}

/** Types a browser may show in place. Anything else is handed over as a download. */
function showsInline(mediaType: string): boolean {
  const kind = assetKind(mediaType)

  return kind !== 'file' || mediaType === 'text/plain'
}

async function serveAsset(
  request: Request,
  bucket: R2Bucket,
  runId: string,
  assetId: string,
  download: boolean,
): Promise<Response> {
  const ranged = request.headers.has('range')
  const found = await getAsset(bucket, runId, assetId, ranged ? { range: request.headers } : {})

  if (!found) {
    return Response.json({ error: 'No such file in this session' }, { status: 404 })
  }

  const { ref, object } = found
  const disposition = !download && showsInline(ref.mediaType) ? 'inline' : 'attachment'

  const headers = new Headers({
    'content-type': ref.mediaType,
    'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
    'accept-ranges': 'bytes',
    etag: object.httpEtag,
    // An asset never changes once stored, but it is private to the people in the session.
    'cache-control': 'private, max-age=31536000, immutable',
    // Files come from people and agents. Opened directly, one must never run as the app:
    // no scripts, no requests, and no guessing a type other than the one stored.
    'content-security-policy':
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:",
    'x-content-type-options': 'nosniff',
  })

  const range = object.range

  if (ranged && range && 'offset' in range) {
    const offset = range.offset ?? 0
    const length = range.length ?? ref.size - offset

    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${ref.size}`)
    headers.set('content-length', String(length))

    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers })
  }

  headers.set('content-length', String(ref.size))

  return new Response(request.method === 'HEAD' ? null : object.body, { headers })
}
