import type { ReactElement } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '../../components/ui/dropdown-menu'

/** One row of a sidebar menu: an action, or a rule between actions. */
export type RowMenuEntry =
  | { readonly kind: 'action'; readonly label: string; readonly onSelect: () => void }
  | { readonly kind: 'separator' }

export function sessionMenuEntries(
  onRename: (() => void) | undefined,
  onArchive: (() => void) | undefined,
): readonly RowMenuEntry[] {
  const entries: RowMenuEntry[] = []

  if (onRename !== undefined) {
    entries.push({ kind: 'action', label: 'Rename', onSelect: onRename })
  }

  if (onArchive !== undefined) {
    entries.push({ kind: 'action', label: 'Archive', onSelect: onArchive })
  }

  return entries
}

export function folderMenuEntries(
  archived: boolean,
  onRename: () => void,
  onLinkRepo: () => void,
  onArchive: () => void,
): readonly RowMenuEntry[] {
  if (archived) {
    return [{ kind: 'action', label: 'Rename', onSelect: onRename }]
  }

  return [
    { kind: 'action', label: 'Rename', onSelect: onRename },
    { kind: 'action', label: 'Link repository…', onSelect: onLinkRepo },
    { kind: 'separator' },
    { kind: 'action', label: 'Archive', onSelect: onArchive },
  ]
}

/**
 * The same actions as the row's "…" menu, opened where the pointer is. The browser's own
 * menu is suppressed for this row.
 */
export function RowContextMenu({
  entries,
  className,
  children,
}: {
  entries: readonly RowMenuEntry[]
  className?: string
  children: ReactElement
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Closing would refocus what had focus before the menu opened, blurring Rename's input. */}
      <ContextMenuContent
        className={className}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <RowMenuItems entries={entries} surface="context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function RowDropdownMenuItems({ entries }: { entries: readonly RowMenuEntry[] }) {
  return <RowMenuItems entries={entries} surface="dropdown" />
}

function RowMenuItems({
  entries,
  surface,
}: {
  entries: readonly RowMenuEntry[]
  surface: 'dropdown' | 'context'
}) {
  return entries.map((entry, index) => {
    if (entry.kind === 'separator') {
      const key = `separator-${index}`

      return surface === 'dropdown' ? (
        <DropdownMenuSeparator key={key} />
      ) : (
        <ContextMenuSeparator key={key} />
      )
    }

    return surface === 'dropdown' ? (
      <DropdownMenuItem key={entry.label} onSelect={entry.onSelect}>
        {entry.label}
      </DropdownMenuItem>
    ) : (
      <ContextMenuItem key={entry.label} onSelect={entry.onSelect}>
        {entry.label}
      </ContextMenuItem>
    )
  })
}
