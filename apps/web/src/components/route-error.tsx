import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/cn'

/** Shown in a page's place when one of its loaders or queries fails. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const queryErrors = useQueryErrorResetBoundary()

  // A query that failed stays failed until it is reset, so trying again has to clear it first.
  useEffect(() => {
    queryErrors.reset()
  }, [queryErrors])

  return (
    <div className="flex h-full min-h-40 items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">This page could not load</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed text-pretty">
          {errorMessage(error)}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            reset()
            void router.invalidate()
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  )
}
