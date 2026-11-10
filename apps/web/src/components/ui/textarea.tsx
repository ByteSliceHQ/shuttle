import type { ComponentProps } from 'react'

import { cn } from '@/lib/cn'

function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-ring/30 flex field-sizing-content min-h-16 w-full rounded-lg border bg-black/15 px-3 py-2.5 text-[13px] leading-relaxed transition-[border-color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
