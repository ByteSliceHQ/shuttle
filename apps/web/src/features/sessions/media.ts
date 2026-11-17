import { z } from 'zod'

import { jsonFields, jsonNumber, jsonText } from '@/lib/json'
import type { JsonValue } from '@swirls/looms/core'

/** A file in a session's media: one a person attached, or one an agent shared. */
export interface MediaAsset {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
}

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

/** One entry in a session's media, with where it came from. */
export interface SessionMedia {
  readonly asset: MediaAsset
  readonly source: 'upload' | 'agent'
  readonly seq: number
  readonly ts: number
  /** The agent that shared it. */
  readonly threadId?: string
  /** The person who attached it. */
  readonly authorName?: string
}

/** Largest file that can be attached, and most files on one message. The Worker enforces both. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

export function mediaKind(mediaType: string): MediaKind {
  const [top] = mediaType.split('/')

  if (top === 'image' || top === 'video' || top === 'audio') {
    return top
  }

  return mediaType === 'application/pdf' ? 'pdf' : 'file'
}

export function mediaUrl(runId: string, assetId: string, download = false): string {
  const url = `/sessions/${encodeURIComponent(runId)}/assets/${encodeURIComponent(assetId)}`

  return download ? `${url}?download` : url
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

/** A media asset read from event JSON, or `undefined` when the value is not one. */
export function mediaAssetOf(value: JsonValue | undefined): MediaAsset | undefined {
  const fields = jsonFields(value)
  const id = jsonText(fields.id)
  const mediaType = jsonText(fields.mediaType)

  if (!id || !mediaType) {
    return undefined
  }

  return {
    id,
    name: jsonText(fields.name) ?? id,
    mediaType,
    size: jsonNumber(fields.size) ?? 0,
  }
}

export function mediaAssetsOf(value: JsonValue | undefined): MediaAsset[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const asset = mediaAssetOf(item)

        return asset ? [asset] : []
      })
    : []
}

/**
 * The file a `share_file` call shared. A worker's result is an object; a vendor agent's arrives
 * as JSON text.
 */
export function sharedAssetOf(result: JsonValue | undefined): MediaAsset | undefined {
  let parsed = result

  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result) as JsonValue
    } catch {
      return undefined
    }
  }

  const fields = jsonFields(parsed)

  return fields.ok === true ? mediaAssetOf(fields.asset) : undefined
}

/** What the Worker answers an upload with: the stored file, or why it was refused. */
const UploadAnswer = z.object({
  asset: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      mediaType: z.string().min(1),
      size: z.number().optional(),
    })
    .optional(),
  error: z.string().optional(),
})

/**
 * Uploads one file to a session and reports progress from 0 to 1. Aborting `signal` cancels it.
 * The file's bytes are the request body, so a large file is never held in memory twice.
 */
export function uploadAsset(
  runId: string,
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()

    request.open(
      'POST',
      `/sessions/${encodeURIComponent(runId)}/assets?name=${encodeURIComponent(file.name)}`,
    )

    request.setRequestHeader('content-type', file.type || 'application/octet-stream')
    request.responseType = 'json'

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(event.loaded / event.total)
      }
    })

    request.addEventListener('load', () => {
      // Anything that is not the expected JSON reads as an answer with nothing in it.
      const answer = UploadAnswer.safeParse(request.response).data ?? {}
      const stored = request.status === 201 ? answer.asset : undefined

      if (stored) {
        resolve({
          id: stored.id,
          name: stored.name ?? stored.id,
          mediaType: stored.mediaType,
          size: stored.size ?? 0,
        })
      } else {
        reject(new Error(answer.error ?? `${file.name} could not be uploaded (${request.status}).`))
      }
    })

    request.addEventListener('error', () =>
      reject(new Error(`${file.name} could not be uploaded. Check your connection.`)),
    )

    request.addEventListener('abort', () =>
      reject(new DOMException('Upload cancelled', 'AbortError')),
    )

    options.signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.send(file)
  })
}
