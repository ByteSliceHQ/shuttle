import { GitCompareArrows } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/cn'
import { fetchSandboxDiff, type SandboxDiffEntry } from '@/lib/sandbox'

export function ChangesViewer({
  runId,
  folderId,
  refreshEpoch,
}: {
  runId: string
  folderId?: string
  refreshEpoch: number
}) {
  const [diffs, setDiffs] = useState<SandboxDiffEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const identity = { runId, folderId, refreshEpoch }

    void fetchSandboxDiff({ runId: identity.runId, folderId: identity.folderId })
      .then((result) => {
        if (!cancelled) {
          setDiffs(result.diffs)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load changes')
          setDiffs([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [runId, folderId, refreshEpoch])

  const files = useMemo(
    () => (diffs ?? []).flatMap((entry) => parseUnifiedDiff(entry.diff, entry.name)),
    [diffs],
  )

  if (error) {
    return (
      <EmptyState icon={<GitCompareArrows />} title="Changes unavailable">
        {error}
      </EmptyState>
    )
  }

  if (!diffs) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading changes…
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <EmptyState icon={<GitCompareArrows />} title="No changes">
        Worktree diffs will appear here as agents edit files.
      </EmptyState>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-3">
        {files.map((file) => (
          <section key={`${file.repo}:${file.path}`} className="min-w-0">
            <header className="text-foreground mb-1.5 flex items-baseline gap-2 font-mono text-[11px]">
              <span className="text-muted-foreground shrink-0">{file.repo}</span>
              <span className="min-w-0 truncate font-medium">{file.path}</span>
            </header>
            <pre className="bg-card overflow-x-auto rounded-md border p-2 font-mono text-[11px] leading-[18px]">
              {file.lines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    'whitespace-pre',
                    line.kind === 'add' && 'bg-status-completed/10 text-status-completed',
                    line.kind === 'del' && 'bg-destructive/10 text-destructive',
                    line.kind === 'hunk' && 'text-muted-foreground',
                  )}
                >
                  {line.text}
                </div>
              ))}
            </pre>
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}

interface DiffLine {
  readonly kind: 'ctx' | 'add' | 'del' | 'hunk' | 'meta'
  readonly text: string
}

interface DiffFile {
  readonly repo: string
  readonly path: string
  readonly lines: DiffLine[]
}

function parseUnifiedDiff(diff: string, repo: string): DiffFile[] {
  if (!diff.trim()) {
    return []
  }

  const files: DiffFile[] = []
  let current: DiffFile | null = null

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = raw.match(/b\/(.+)$/)

      current = {
        repo,
        path: match?.[1] ?? 'unknown',
        lines: [],
      }

      files.push(current)

      continue
    }

    if (!current) {
      current = { repo, path: 'patch', lines: [] }
      files.push(current)
    }

    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ')) {
      current.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('@@')) {
      current.lines.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw })
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw })
    } else {
      current.lines.push({ kind: 'ctx', text: raw })
    }
  }

  return files
}
