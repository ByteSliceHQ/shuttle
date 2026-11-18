import { File, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog'
import { ScrollArea } from '../../components/ui/scroll-area'
import { cn } from '../../lib/cn'
import { hasText } from '../../lib/text'
import { searchFiles } from './file-search'

/** The hint for the shortcut that opens file search, as this platform writes it. */
export function quickOpenShortcut(): string {
  return /mac|iphone|ipad/i.test(navigator.userAgent) ? '⌘P' : 'Ctrl+P'
}

/**
 * Go to file: type part of a name, arrow to a result, Enter to open it. With nothing typed it
 * lists the files already open, most recent first, then the rest.
 */
export function FileQuickOpen({
  open,
  onOpenChange,
  paths,
  recent,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every file, as a path under the session's worktree. */
  paths: readonly string[]
  /** Files already open, in the order they were opened. */
  recent: readonly string[]
  onPick: (path: string) => void
}) {
  // Counts openings, so each one gets a fresh search even when it follows the last so closely
  // that the dialog had not finished closing.
  const [wasOpen, setWasOpen] = useState(open)
  const [opening, setOpening] = useState(0)

  if (wasOpen !== open) {
    setWasOpen(open)

    if (open) {
      setOpening(opening + 1)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent instant className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <DialogDescription className="sr-only">
          Type part of a file name, then use the arrow keys and Enter to open it.
        </DialogDescription>
        <QuickOpenBody
          key={opening}
          paths={paths}
          recent={recent}
          onPick={(path) => {
            onPick(path)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function QuickOpenBody({
  paths,
  recent,
  onPick,
}: {
  paths: readonly string[]
  recent: readonly string[]
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo(() => {
    if (query.trim() !== '') {
      return searchFiles(paths, query)
    }

    const present = new Set(paths)
    const first = recent.toReversed().filter((path) => present.has(path))
    const seen = new Set(first)

    return [...first, ...searchFiles(paths, '').filter((path) => !seen.has(path))].slice(0, 50)
  }, [paths, recent, query])

  const active = Math.min(cursor, Math.max(results.length - 1, 0))

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (path: string | undefined) => {
    if (hasText(path)) {
      onPick(path)
    }
  }

  return (
    <>
      <div className="flex h-11 items-center gap-2 border-b px-3.5">
        <Search className="text-muted-foreground size-4 shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor(Math.min(active + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor(Math.max(active - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              pick(results[active])
            }
          }}
          placeholder="Go to file…"
          aria-label="Search files by name"
          role="combobox"
          aria-expanded
          aria-controls="file-quick-open-results"
          aria-activedescendant={
            results[active] !== undefined ? `file-result-${active}` : undefined
          }
          spellCheck={false}
          autoComplete="off"
          className="placeholder:text-muted-foreground/70 h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>
      {results.length === 0 ? (
        <p className="text-muted-foreground px-3.5 py-6 text-center text-[12px]">
          No file matches “{query.trim()}”.
        </p>
      ) : (
        <ScrollArea className="max-h-80" viewportClassName="max-h-80">
          <ul ref={listRef} id="file-quick-open-results" role="listbox" className="p-1.5">
            {results.map((path, index) => {
              const slash = path.lastIndexOf('/')

              return (
                <li
                  key={path}
                  id={`file-result-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => pick(path)}
                  className={cn(
                    'flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px]',
                    index === active && 'bg-accent text-accent-foreground',
                  )}
                >
                  <File className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="shrink-0">{path.slice(slash + 1)}</span>
                  <span className="text-muted-foreground min-w-0 truncate text-[11.5px]">
                    {slash > 0 ? path.slice(0, slash) : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </>
  )
}
