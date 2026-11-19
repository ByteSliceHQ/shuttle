import { Check, Copy, FileText, MessagesSquare } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../../lib/cn'
import { Link } from '../../../shuttle'
import { copyMentionedText } from './clipboard'
import { splitMentions, type MentionReference } from './tokens'

const MENTION =
  'bg-brand/15 text-foreground hover:bg-brand/25 focus-visible:ring-ring/50 ease-snappy inline rounded-[4px] px-1 py-px font-medium transition-colors duration-150 outline-none focus-visible:ring-[3px] [box-decoration-break:clone]'

/**
 * A person's message with what it points at with `@` marked. A file opens in the artifacts pane,
 * where the session has one to open it in; a session is a link to it.
 */
export function MentionText({
  text,
  references,
  onOpenFile,
}: {
  text: string
  references: readonly MentionReference[] | undefined
  /** Opens a file of the session's worktree. Absent where nothing can show one. */
  onOpenFile?: (path: string) => void
}) {
  const spans = splitMentions(text, references ?? [])

  // Where a run starts in the text keys it: the same mention can appear twice.
  return spans.map((span) => {
    const key = span.start
    const { reference } = span

    if (reference === undefined) {
      return span.text
    }

    if (reference.kind === 'session') {
      return (
        <Link
          key={key}
          to={{ page: 'session', sessionId: reference.sessionId }}
          title={`Open the session “${reference.title}”`}
          className={MENTION}
        >
          <MessagesSquare className="mr-1 inline size-3 -translate-y-px opacity-70" />
          {span.text.slice(1)}
        </Link>
      )
    }

    if (onOpenFile === undefined) {
      return (
        <span key={key} className={cn(MENTION, 'hover:bg-brand/15')}>
          <FileText className="mr-1 inline size-3 -translate-y-px opacity-70" />
          {span.text.slice(1)}
        </span>
      )
    }

    return (
      <button
        key={key}
        type="button"
        onClick={() => onOpenFile(reference.path)}
        title={`Open ${reference.path}`}
        className={cn(MENTION, 'cursor-pointer text-left')}
      >
        <FileText className="mr-1 inline size-3 -translate-y-px opacity-70" />
        {span.text.slice(1)}
      </button>
    )
  })
}

/**
 * Copies a message, keeping its mentions for pasting back into the message box. Shown while the
 * pointer is over the message, or when it has the keyboard focus.
 */
export function CopyMessageButton({
  text,
  references,
  className,
}: {
  text: string
  references: readonly MentionReference[] | undefined
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
      onClick={() => {
        // A copy the browser refused leaves the icon as it was, so nothing claims it worked.
        copyMentionedText(text, references ?? []).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
      onPointerLeave={() => setCopied(false)}
      onBlur={() => setCopied(false)}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded-md transition-[opacity,background-color,color] duration-150 outline-none focus-visible:opacity-100 focus-visible:ring-[3px]',
        className,
      )}
    >
      {copied ? <Check className="text-status-completed size-3" /> : <Copy className="size-3" />}
    </button>
  )
}
