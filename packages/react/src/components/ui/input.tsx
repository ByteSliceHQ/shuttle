import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'border-input placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-ring/30 flex h-9 w-full min-w-0 rounded-lg border bg-black/15 px-3 py-1 text-[13px] transition-[border-color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
