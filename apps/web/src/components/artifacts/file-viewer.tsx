import { FileCode2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fetchSandboxFile } from '@/lib/sandbox'

export function FileViewer({
  runId,
  folderId,
  path,
  refreshEpoch,
}: {
  runId: string
  folderId?: string
  path: string
  refreshEpoch: number
}) {
  const [content, setContent] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const identity = { runId, folderId, path, refreshEpoch }

    void fetchSandboxFile({ runId: identity.runId, folderId: identity.folderId }, identity.path)
      .then((result) => {
        if (cancelled) {
          return
        }

        setContent(result.content)
        setBinary(Boolean(result.binary))
        setTruncated(Boolean(result.truncated))
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return
        }

        setError(cause instanceof Error ? cause.message : 'Failed to read file')
        setContent(null)
      })

    return () => {
      cancelled = true
    }
  }, [runId, folderId, path, refreshEpoch])

  if (error) {
    return (
      <EmptyState icon={<FileCode2 />} title="Could not open file">
        {error}
      </EmptyState>
    )
  }

  if (content === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading…
      </div>
    )
  }

  if (binary) {
    return (
      <EmptyState icon={<FileCode2 />} title="Binary file">
        {path} cannot be previewed as text.
      </EmptyState>
    )
  }

  const lines = content.split('\n')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-b px-3 font-mono text-[11px]">
        <span className="min-w-0 truncate" title={path}>
          {path}
        </span>
        {truncated ? <span className="shrink-0">truncated</span> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <pre className="px-0 py-2 font-mono text-[11px] leading-[18px]">
          {lines.map((line, index) => (
            <div key={index} className="hover:bg-accent/30 flex">
              <span className="text-muted-foreground/50 w-12 shrink-0 pr-3 text-right tabular-nums select-none">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">
                {line || ' '}
              </span>
            </div>
          ))}
        </pre>
      </ScrollArea>
    </div>
  )
}
