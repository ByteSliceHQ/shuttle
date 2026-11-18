import { useRef } from 'react'

import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'

export const NAME_MAX_LENGTH = 120

/** Escape cancels even though unmounting the input blurs it afterwards. */
export function InlineNameInput({
  initialValue,
  label,
  onCommit,
  onCancel,
  commitUnchanged = false,
  className,
}: {
  initialValue: string
  label: string
  onCommit: (value: string) => void
  onCancel: () => void
  commitUnchanged?: boolean
  className?: string
}) {
  const settled = useRef(false)

  function commit(value: string) {
    if (settled.current) {
      return
    }

    settled.current = true
    const trimmed = value.replace(/\s+/g, ' ').trim()

    if (trimmed !== '' && (commitUnchanged || trimmed !== initialValue)) {
      onCommit(trimmed)
    } else {
      onCancel()
    }
  }

  return (
    <Input
      autoFocus
      aria-label={label}
      defaultValue={initialValue}
      maxLength={NAME_MAX_LENGTH}
      dir="auto"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit(event.currentTarget.value)
        }

        if (event.key === 'Escape') {
          event.preventDefault()
          settled.current = true
          onCancel()
        }
      }}
      className={cn('h-7 px-2 text-[12.5px]', className)}
    />
  )
}
