import { Download, FileAudio, FileText, FileVideo, Paperclip, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'

import { formatBytes, mediaKind, mediaUrl, type MediaAsset, type MediaKind } from './media'

const KIND_ICON: Record<Exclude<MediaKind, 'image'>, ReactNode> = {
  video: <FileVideo />,
  audio: <FileAudio />,
  pdf: <FileText />,
  file: <Paperclip />,
}

/** A file as a row: its kind, name and size, opening or downloading it when pressed. */
export function FileChip({
  runId,
  asset,
  className,
}: {
  runId: string
  asset: MediaAsset
  className?: string
}) {
  const kind = mediaKind(asset.mediaType)
  // A PDF opens in the browser's own viewer. Other files have nothing to show them, so they save.
  const opens = kind === 'pdf'

  return (
    <a
      href={mediaUrl(runId, asset.id, !opens)}
      {...(opens ? { target: '_blank', rel: 'noreferrer' } : { download: asset.name })}
      className={cn(
        'bg-card hover:bg-accent/60 ease-snappy flex max-w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-150',
        className,
      )}
    >
      <span className="text-muted-foreground bg-secondary flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4">
        {kind === 'image' ? <Paperclip /> : KIND_ICON[kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" dir="auto">
          {asset.name}
        </span>
        <span className="text-muted-foreground block text-[11px] tabular-nums">
          {formatBytes(asset.size)}
        </span>
      </span>
      {opens ? null : <Download className="text-muted-foreground size-3.5 shrink-0" />}
    </a>
  )
}

/**
 * One file, shown the way its kind allows: an image as a thumbnail that opens full size, video
 * and audio as players, anything else as a row that opens or downloads it.
 */
export function MediaTile({
  runId,
  asset,
  size = 'md',
  className,
}: {
  runId: string
  asset: MediaAsset
  /** `md` suits a message; `fill` takes the width of its container, for a grid. */
  size?: 'md' | 'fill'
  className?: string
}) {
  const kind = mediaKind(asset.mediaType)
  const [broken, setBroken] = useState(false)
  const url = mediaUrl(runId, asset.id)

  if (broken) {
    return <FileChip runId={runId} asset={asset} className={className} />
  }

  if (kind === 'image') {
    return (
      <ImageLightbox runId={runId} asset={asset}>
        <button
          type="button"
          aria-label={`Open ${asset.name}`}
          className={cn(
            'bg-secondary/60 focus-visible:ring-ring/50 ease-snappy block overflow-hidden rounded-lg border transition-[filter,transform] duration-150 outline-none hover:brightness-110 focus-visible:ring-[3px] active:scale-[0.99]',
            size === 'fill' ? 'aspect-4/3 w-full' : 'max-w-full',
            className,
          )}
        >
          <img
            src={url}
            alt={asset.name}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className={cn(
              size === 'fill' ? 'size-full object-cover' : 'max-h-64 max-w-full object-contain',
            )}
          />
        </button>
      </ImageLightbox>
    )
  }

  if (kind === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        aria-label={asset.name}
        onError={() => setBroken(true)}
        className={cn(
          'rounded-lg border bg-black',
          size === 'fill' ? 'aspect-video w-full' : 'max-h-80 max-w-full',
          className,
        )}
      />
    )
  }

  if (kind === 'audio') {
    return (
      <div
        className={cn(
          'bg-card flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5',
          size === 'fill' ? 'w-full' : 'w-80 max-w-full',
          className,
        )}
      >
        <span className="truncate text-[12.5px] font-medium" dir="auto">
          {asset.name}
        </span>
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={asset.name}
          onError={() => setBroken(true)}
          className="h-9 w-full"
        />
      </div>
    )
  }

  return (
    <FileChip
      runId={runId}
      asset={asset}
      className={cn(size === 'fill' ? 'w-full' : 'w-72', className)}
    />
  )
}

/** Files side by side, wrapping. Used under a message and for what an agent shared. */
export function MediaStrip({
  runId,
  assets,
  align = 'start',
  className,
}: {
  runId: string
  assets: readonly MediaAsset[]
  align?: 'start' | 'end'
  className?: string
}) {
  if (assets.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'flex max-w-full flex-wrap gap-2',
        align === 'end' ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      {assets.map((asset) => (
        <MediaTile key={asset.id} runId={runId} asset={asset} />
      ))}
    </div>
  )
}

function ImageLightbox({
  runId,
  asset,
  children,
}: {
  runId: string
  asset: MediaAsset
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <span onClick={() => setOpen(true)} className="contents">
        {children}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-auto max-w-[calc(100vw-2rem)] flex-col gap-3 p-3">
          <div className="flex min-w-0 items-center gap-2 pl-1">
            <DialogTitle className="min-w-0 flex-1 truncate text-[13px]" dir="auto">
              {asset.name}
            </DialogTitle>
            <DialogDescription className="shrink-0 tabular-nums">
              {formatBytes(asset.size)}
            </DialogDescription>
            <a
              href={mediaUrl(runId, asset.id, true)}
              download={asset.name}
              aria-label={`Download ${asset.name}`}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
            >
              <Download className="size-3.5" />
            </a>
            <DialogClose
              aria-label="Close"
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
            >
              <X className="size-3.5" />
            </DialogClose>
          </div>
          <img
            src={mediaUrl(runId, asset.id)}
            alt={asset.name}
            className="min-h-0 max-w-full flex-1 rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
