/**
 * Media for a session: files people attach to messages and files agents make. The bytes live in
 * R2 under the session's run id; events and messages carry only an `AssetRef`.
 */

export interface AssetRef {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
}

/** Whether a person attached the file or an agent made it. */
export type AssetSource = 'upload' | 'agent'

export type AssetKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

/** Largest file a person may attach or an agent may share. */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024
/** Most files one message may carry. */
export const MAX_ATTACHMENTS = 10

const ASSET_ID = /^ast_[0-9a-f]{32}$/

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ASSET_ID.test(value)
}

export function newAssetId(): string {
  return `ast_${crypto.randomUUID().replaceAll('-', '')}`
}

function assetKey(runId: string, assetId: string): string {
  return `sessions/${runId}/${assetId}`
}

export function assetKind(mediaType: string): AssetKind {
  const [top] = mediaType.split('/')

  if (top === 'image' || top === 'video' || top === 'audio') {
    return top
  }

  return mediaType === 'application/pdf' ? 'pdf' : 'file'
}

const MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
  ['bmp', 'image/bmp'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['m4a', 'audio/mp4'],
  ['flac', 'audio/flac'],
  ['pdf', 'application/pdf'],
  ['json', 'application/json'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['html', 'text/html'],
  ['zip', 'application/zip'],
])

/** The media type a file name implies, for files that arrive without one. */
export function mediaTypeOfName(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()

  return MEDIA_TYPES.get(extension) ?? 'application/octet-stream'
}

/** A file name safe to show, store and use as the last part of a path. */
export function cleanAssetName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''

  const cleaned = base
    // oxlint-disable-next-line no-control-regex -- stripping control characters from a file name is the intent here
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 160)

  return cleaned !== '' && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file'
}

/**
 * The type to store for an uploaded file: what the browser declared, unless it declared nothing
 * useful, in which case the file name decides.
 */
export function uploadMediaType(declared: string | null | undefined, name: string): string {
  const type = cleanMediaType(declared)

  return type !== null && type !== 'application/octet-stream' ? type : mediaTypeOfName(name)
}

/** A media type as a browser reports it, without parameters, or `null` when it is not one. */
export function cleanMediaType(value: string | null | undefined): string | null {
  const type = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : null
}

export interface PutAssetInput {
  readonly name: string
  readonly mediaType: string
  readonly body: ReadableStream | ArrayBuffer | ArrayBufferView | Blob
  readonly source: AssetSource
  /** The person who attached it, or the agent thread that made it. */
  readonly createdBy: string
}

export async function putAsset(
  bucket: R2Bucket,
  runId: string,
  input: PutAssetInput,
): Promise<AssetRef> {
  const id = newAssetId()
  const name = cleanAssetName(input.name)

  const stored = await bucket.put(assetKey(runId, id), input.body, {
    httpMetadata: { contentType: input.mediaType },
    customMetadata: {
      // Metadata travels in headers, which carry ASCII only.
      name: encodeURIComponent(name),
      source: input.source,
      createdBy: input.createdBy,
    },
  })

  return { id, name, mediaType: input.mediaType, size: stored.size }
}

function refOf(id: string, object: R2Object): AssetRef {
  const stored = object.customMetadata?.name

  return {
    id,
    name: stored !== undefined && stored !== '' ? decodeURIComponent(stored) : id,
    mediaType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    size: object.size,
  }
}

/** The asset's description, or `null` when this session has no such asset. */
export async function headAsset(
  bucket: R2Bucket,
  runId: string,
  assetId: string,
): Promise<AssetRef | null> {
  if (!ASSET_ID.test(assetId)) {
    return null
  }

  const object = await bucket.head(assetKey(runId, assetId))

  return object ? refOf(assetId, object) : null
}

export async function getAsset(
  bucket: R2Bucket,
  runId: string,
  assetId: string,
  options: { readonly range?: Headers } = {},
): Promise<{ ref: AssetRef; object: R2ObjectBody } | null> {
  if (!ASSET_ID.test(assetId)) {
    return null
  }

  const object = await bucket.get(
    assetKey(runId, assetId),
    options.range ? { range: options.range } : {},
  )

  return object ? { ref: refOf(assetId, object), object } : null
}

export async function deleteAsset(bucket: R2Bucket, runId: string, assetId: string): Promise<void> {
  if (ASSET_ID.test(assetId)) {
    await bucket.delete(assetKey(runId, assetId))
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
