import { FileCode2, FileQuestion } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { highlight, tokenStyle, type HighlightedLine } from '@/lib/highlight'
import { fetchSandboxFile } from '@/lib/sandbox'

interface Loaded {
  /** The path this content belongs to, so a slower earlier request cannot overwrite a newer one. */
  readonly path: string
  readonly content: string
  readonly binary: boolean
  readonly truncated: boolean
}

/**
 * One file's contents, with line numbers and syntax colours. `path` is relative to the session's
 * worktree. The file is read again whenever `refreshEpoch` changes, and what is on screen stays
 * until the new contents arrive, so an agent's edits appear without a flash.
 */
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
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ path: string; message: string } | null>(null)
  const [lines, setLines] = useState<{ content: string; tokens: HighlightedLine[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    const identity = { runId, folderId, path, refreshEpoch }

    fetchSandboxFile({ runId: identity.runId, folderId: identity.folderId }, identity.path)
      .then((result) => {
        if (!cancelled) {
          setLoaded({
            path: identity.path,
            content: result.content,
            binary: Boolean(result.binary),
            truncated: Boolean(result.truncated),
          })

          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError({
            path: identity.path,
            message: cause instanceof Error ? cause.message : 'Failed to read file',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [runId, folderId, path, refreshEpoch])

  const current = loaded?.path === path ? loaded : null
  const content = current && !current.binary ? current.content : null

  useEffect(() => {
    if (content === null) {
      return
    }

    let cancelled = false

    void highlight(content, path).then((tokens) => {
      if (!cancelled) {
        setLines(tokens ? { content, tokens } : null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [content, path])

  const plain = useMemo(() => (content === null ? [] : content.split('\n')), [content])

  if (error?.path === path && !current) {
    return (
      <EmptyState icon={<FileQuestion />} title="Could not open file">
        {error.message.includes('404')
          ? `${path} is not in the session's files any more.`
          : error.message}
      </EmptyState>
    )
  }

  if (!current) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading…
      </div>
    )
  }

  if (current.binary) {
    return (
      <EmptyState icon={<FileCode2 />} title="Binary file">
        {path.split('/').pop()} cannot be shown as text.
      </EmptyState>
    )
  }

  // Colours computed for an earlier version of the file are not laid over the new text.
  const tokens = lines?.content === content ? lines.tokens : null
  const count = tokens?.length ?? plain.length
  const gutter = `${Math.max(String(count).length, 2) + 2}ch`

  return (
    <div className="h-full min-h-0 overflow-auto">
      <pre
        className="w-max min-w-full py-2 font-mono text-[12px] leading-[19px]"
        style={{ tabSize: 2 }}
      >
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="hover:bg-accent/30 flex">
            <span
              className="text-muted-foreground/45 bg-background sticky left-0 shrink-0 pr-3 text-right tabular-nums select-none"
              style={{ width: gutter }}
            >
              {index + 1}
            </span>
            <span className="pr-4 pl-1 whitespace-pre">
              {tokens
                ? (tokens[index] ?? []).map((token, at) => (
                    <span key={at} style={tokenStyle(token)}>
                      {token.content}
                    </span>
                  ))
                : plain[index]}
            </span>
          </div>
        ))}
        {current.truncated ? (
          <div className="text-muted-foreground px-4 pt-2 font-sans text-[11px]">
            This file is too large to show in full. The rest is cut off.
          </div>
        ) : null}
      </pre>
    </div>
  )
}
