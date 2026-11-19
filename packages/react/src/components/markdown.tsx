import pierreDark from '@pierre/highlights/themes/pierre-dark'
import { createHighlightsPlugin } from '@pierre/words/highlights'
import { type Components, Markdown as Words } from '@pierre/words/react'
import { memo } from 'react'

import { cn } from '../lib/cn'

/**
 * Hooks get and return each element's whole HTML. Links leave the app, and a table scrolls in a
 * frame of its own so it can still fill the width.
 */
const components: Components = {
  a: (html) => html.replace('<a ', '<a target="_blank" rel="noreferrer" '),
  table: (html) => `<div data-markdown="table-frame">${html}</div>`,
}

const controls = { code: { copy: true, download: false } }

/**
 * Code fences use `@pierre/highlights`, the highlighter `@pierre/diffs` runs on, with the diff
 * viewer's theme. An open fence keeps a live tokenizer, so a streamed line re-highlights alone.
 */
const plugins = { code: createHighlightsPlugin({ theme: pierreDark }) }

/**
 * Agent output is markdown; render it with the conversation's type scale. `@pierre/words`
 * renders it, and `theme.css` styles its `data-markdown` elements. While `streaming` is true,
 * unfinished syntax is completed as it arrives, new text fades in, and a caret follows it.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
  streaming = false,
}: {
  text: string
  className?: string
  streaming?: boolean
}) {
  return (
    <Words
      className={cn('break-words', className)}
      isAnimating={streaming}
      animated={streaming}
      caret={streaming ? 'block' : undefined}
      components={components}
      controls={controls}
      plugins={plugins}
      lineNumbers={false}
    >
      {text}
    </Words>
  )
})
