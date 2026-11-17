import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Kbd } from './ui/panel'
import { ScrollArea } from './ui/scroll-area'

export interface Command {
  readonly id: string
  readonly label: string
  readonly icon: ReactNode
  /** How its own shortcut reads, so the palette teaches the faster way. */
  readonly shortcut?: string
  /** Extra words to find it by, beyond its label. */
  readonly keywords?: string
  readonly run: () => void
}

/** The commands whose label or keywords contain every word typed, in their given order. */
export function matchCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return commands.filter((command) => {
    const text = `${command.label} ${command.keywords ?? ''}`.toLowerCase()

    return words.every((word) => text.includes(word))
  })
}

/**
 * Every pane and action the session keeps out of sight, in one searchable list. Type part of a
 * name, arrow to a command, Enter to run it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: readonly Command[]
}) {
  // Counts openings, so each one starts with an empty search.
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
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <DialogDescription className="sr-only">
          Type part of a command, then use the arrow keys and Enter to run it.
        </DialogDescription>
        <PaletteBody
          key={opening}
          commands={commands}
          onRun={(command) => {
            onOpenChange(false)
            command.run()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({
  commands,
  onRun,
}: {
  commands: readonly Command[]
  onRun: (command: Command) => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const results = useMemo(() => matchCommands(commands, query), [commands, query])
  const active = Math.min(cursor, Math.max(results.length - 1, 0))

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (command: Command | undefined) => {
    if (command) {
      onRun(command)
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
              run(results[active])
            }
          }}
          placeholder="Show a pane or run a command"
          aria-label="Search commands"
          role="combobox"
          aria-expanded
          aria-controls="command-palette-results"
          aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="placeholder:text-muted-foreground/70 h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>
      {results.length === 0 ? (
        <p className="text-muted-foreground px-3.5 py-6 text-center text-[12px]">
          No command matches “{query.trim()}”.
        </p>
      ) : (
        <ScrollArea className="max-h-80" viewportClassName="max-h-80">
          <ul ref={listRef} id="command-palette-results" role="listbox" className="p-1.5">
            {results.map((command, index) => (
              <li
                key={command.id}
                id={`command-${command.id}`}
                role="option"
                aria-selected={index === active}
                onMouseMove={() => setCursor(index)}
                onClick={() => run(command)}
                className={cn(
                  'flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[12.5px]',
                  index === active && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
                  {command.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.shortcut ? <Kbd>{command.shortcut}</Kbd> : null}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </>
  )
}
