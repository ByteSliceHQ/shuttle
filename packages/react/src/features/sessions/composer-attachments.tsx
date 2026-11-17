import { AlertCircle, FileAudio, FileText, FileVideo, Paperclip, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { cn, errorMessage } from '../../lib/cn'
import { useShuttleHost } from '../../shuttle'
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  mediaKind,
  uploadAsset,
  type MediaAsset,
} from './media'

/** A file chosen for the message being written. It uploads as soon as it is chosen. */
export interface PendingAttachment {
  readonly key: string
  readonly file: File
  /** A local preview, for images. */
  readonly previewUrl?: string
  readonly status: 'uploading' | 'ready' | 'error'
  /** Upload progress from 0 to 1. */
  readonly progress: number
  readonly error?: string
  /** Settles when the upload does. A message sent meanwhile waits on it. */
  readonly uploaded: Promise<MediaAsset>
  readonly cancel: () => void
}

/**
 * The files attached to the message being written. Each uploads on its own while the person
 * keeps typing, so sending rarely has to wait.
 */
export function useComposerAttachments(runId: string) {
  const host = useShuttleHost()
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([])
  const [rejection, setRejection] = useState<string | null>(null)
  /** The latest files, for callbacks that must not change identity as files come and go. */
  const live = useRef(attachments)

  useEffect(() => {
    live.current = attachments
  }, [attachments])

  // Previews are object URLs, which the browser keeps until they are released.
  useEffect(
    () => () => {
      for (const attachment of live.current) {
        attachment.cancel()

        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl)
        }
      }
    },
    [],
  )

  const patch = useCallback((key: string, change: Partial<PendingAttachment>) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.key === key ? { ...attachment, ...change } : attachment,
      ),
    )
  }, [])

  const add = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return
      }

      const room = MAX_ATTACHMENTS - live.current.length
      const accepted: PendingAttachment[] = []
      let refused: string | null = null

      for (const file of files) {
        if (accepted.length >= room) {
          refused = `A message can carry up to ${MAX_ATTACHMENTS} files.`
          break
        }

        if (file.size > MAX_ATTACHMENT_BYTES) {
          refused = `${file.name} is ${formatBytes(file.size)}. Files can be up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`
          continue
        }

        if (file.size === 0) {
          refused = `${file.name} is empty.`
          continue
        }

        const key = crypto.randomUUID()
        const controller = new AbortController()

        const uploaded = uploadAsset(host, runId, file, {
          signal: controller.signal,
          onProgress: (progress) => patch(key, { progress }),
        })

        uploaded.then(
          () => patch(key, { status: 'ready', progress: 1 }),
          (cause: unknown) => {
            if (!controller.signal.aborted) {
              patch(key, { status: 'error', error: errorMessage(cause) })
            }
          },
        )

        accepted.push({
          key,
          file,
          ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {}),
          status: 'uploading',
          progress: 0,
          uploaded,
          cancel: () => controller.abort(),
        })
      }

      setRejection(refused)

      if (accepted.length > 0) {
        setAttachments((current) => [...current, ...accepted])
      }
    },
    [host, runId, patch],
  )

  const remove = useCallback((key: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.key === key)

      removed?.cancel()

      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl)
      }

      return current.filter((attachment) => attachment.key !== key)
    })

    setRejection(null)
  }, [])

  /** Hands the current files to a message being sent and empties the composer. */
  const take = useCallback((): readonly PendingAttachment[] => {
    const taken = live.current

    setAttachments([])
    setRejection(null)

    return taken
  }, [])

  /** Puts files back, for a message that could not be sent. */
  const restore = useCallback((returned: readonly PendingAttachment[]) => {
    setAttachments((current) => [...returned, ...current])
  }, [])

  return { attachments, rejection, add, remove, take, restore }
}

/** Releases the previews of files whose message has been sent. */
export function releaseAttachments(attachments: readonly PendingAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }
}

export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: readonly PendingAttachment[]
  onRemove: (key: string) => void
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.key} attachment={attachment} onRemove={onRemove} />
      ))}
    </ul>
  )
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment
  onRemove: (key: string) => void
}) {
  const { file, status } = attachment
  const kind = mediaKind(file.type)
  const percent = Math.round(attachment.progress * 100)

  const detail =
    status === 'error'
      ? (attachment.error ?? 'Could not upload')
      : status === 'uploading'
        ? `Uploading ${percent}%`
        : formatBytes(file.size)

  return (
    <li
      title={status === 'error' ? attachment.error : file.name}
      className={cn(
        'bg-secondary/60 relative flex h-12 max-w-56 min-w-0 items-center gap-2 overflow-hidden rounded-lg border pr-7 pl-1.5',
        status === 'error' && 'border-status-failed/50',
      )}
    >
      <span className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md [&_svg]:size-4">
        {status === 'error' ? (
          <AlertCircle className="text-status-failed" />
        ) : attachment.previewUrl ? (
          <img src={attachment.previewUrl} alt="" className="size-full object-cover" />
        ) : kind === 'video' ? (
          <FileVideo />
        ) : kind === 'audio' ? (
          <FileAudio />
        ) : kind === 'pdf' ? (
          <FileText />
        ) : (
          <Paperclip />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium" dir="auto">
          {file.name}
        </span>
        <span
          role={status === 'error' ? 'alert' : undefined}
          className={cn(
            'block truncate text-[11px] tabular-nums',
            status === 'error' ? 'text-status-failed' : 'text-muted-foreground',
          )}
        >
          {detail}
        </span>
      </span>
      <button
        type="button"
        onClick={() => onRemove(attachment.key)}
        aria-label={`Remove ${file.name}`}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 absolute top-1 right-1 flex size-5 items-center justify-center rounded outline-none focus-visible:ring-[3px]"
      >
        <X className="size-3" />
      </button>
      {status === 'uploading' ? (
        <span
          aria-hidden
          className="bg-brand absolute bottom-0 left-0 h-0.5 origin-left transition-[width] duration-150 ease-out"
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      ) : null}
    </li>
  )
}
