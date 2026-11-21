import type { Ref } from 'react'

import { cn } from '../../../lib/cn'
import type { MentionPick } from './picks'
import { splitMentions } from './tokens'

/**
 * The message box's text metrics. The highlight layer behind the text box uses the same, so its
 * words wrap where the text box's do and each highlight sits under its mention. The text box
 * takes them from here.
 */
export const MESSAGE_TEXT_METRICS =
  'px-3.5 pt-2.5 pb-1.5 text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:break-word]'

/**
 * The message box's text again, behind it and invisible, with the mentions it has picked marked.
 * Only the marks' backgrounds show, under the text box's own transparent-backed text.
 */
export function MentionHighlights({
  ref,
  text,
  picks,
}: {
  ref: Ref<HTMLDivElement>
  text: string
  picks: readonly MentionPick[]
}) {
  const spans = splitMentions(
    text,
    picks.map((pick) => pick.shown),
  )

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        MESSAGE_TEXT_METRICS,
        'pointer-events-none absolute inset-0 overflow-hidden text-transparent select-none',
      )}
    >
      {spans.map((span) =>
        span.reference === undefined ? (
          span.text
        ) : (
          <mark
            // Where it starts in the text keys it: the same mention can appear twice.
            key={span.start}
            className="bg-brand/20 ring-brand/35 rounded-[3px] text-transparent ring-1"
          >
            {span.text}
          </mark>
        ),
      )}
      {/* A last line break needs something after it to take up its line, as the text box does. */}
      {text.endsWith('\n') ? '\u200b' : null}
    </div>
  )
}
