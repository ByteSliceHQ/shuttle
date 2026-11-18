import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap outline-none select-none',
    'focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
    'ease-snappy transition-[transform,background-color,color,opacity,box-shadow] duration-150 active:scale-[0.97]',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        brand:
          'bg-brand text-brand-foreground hover:bg-brand/90 shadow-[inset_0_1px_0_oklch(1_0_0/25%)]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        outline: 'border-input hover:bg-accent hover:text-accent-foreground border bg-transparent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive: 'bg-destructive/15 text-destructive hover:bg-destructive/25',
        success: 'bg-status-completed/15 text-status-completed hover:bg-status-completed/25',
      },
      size: {
        xs: 'h-6 gap-1 rounded-sm px-2 text-[11px] [&_svg]:size-3',
        sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5',
        default: 'h-8 gap-1.5 rounded-md px-3 text-[13px] [&_svg]:size-3.5',
        lg: 'h-9 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4',
        'icon-xs': 'size-6 rounded-sm [&_svg]:size-3',
        'icon-sm': 'size-7 rounded-md [&_svg]:size-3.5',
        icon: 'size-8 rounded-md [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (props.type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
