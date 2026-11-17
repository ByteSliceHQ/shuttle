import { ShuttleMark } from './shuttle-mark'

/** Fills a page's place while its loaders run, when there is no earlier page to keep showing. */
export function RoutePending() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex h-full min-h-40 items-center justify-center"
    >
      <ShuttleMark className="text-muted-foreground size-6 animate-pulse" />
    </div>
  )
}
