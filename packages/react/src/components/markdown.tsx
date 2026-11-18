import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '../lib/cn'

const components: Components = {
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => (
    <h3 className="text-foreground mt-4 mb-1.5 text-sm font-semibold first:mt-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h3 className="text-foreground mt-4 mb-1.5 text-sm font-semibold first:mt-0" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h4 className="text-foreground mt-3 mb-1 text-[13px] font-semibold first:mt-0" {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 className="text-foreground mt-3 mb-1 text-[13px] font-semibold first:mt-0" {...props} />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="text-foreground font-semibold" {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a
      className="text-brand underline-offset-2 hover:underline"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="marker:text-muted-foreground my-2 list-disc space-y-1 pl-5" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="marker:text-muted-foreground my-2 list-decimal space-y-1 pl-5" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="text-muted-foreground my-2 border-l-2 pl-3" {...props} />
  ),
  hr: () => <hr className="my-3" />,
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border bg-black/25 p-3 font-mono text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        'text-foreground rounded bg-white/6 px-1 py-px font-mono text-[0.88em]',
        className,
      )}
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-lg border">
      <table className="w-full text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="bg-card border-b px-2.5 py-1.5 text-left font-medium" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b px-2.5 py-1.5 align-top [tr:last-child_&]:border-b-0" {...props} />
  ),
}

const remarkPlugins = [remarkGfm]

/** Agent output is markdown; render it with the conversation's type scale. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div className={cn('break-words', className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
