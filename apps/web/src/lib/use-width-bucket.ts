import { useCallback, useState } from 'react'

function bucketFor(width: number, thresholds: readonly number[]): number {
  return thresholds.filter((threshold) => width >= threshold).length
}

/**
 * How many of the ascending `thresholds` an element's width has reached. It re-renders only
 * when the width crosses a threshold, not on every pixel of a resize. Until the element
 * mounts it reports the widest bucket.
 */
export function useWidthBucket<T extends HTMLElement>(
  thresholds: readonly number[],
): [(node: T | null) => void, number] {
  const [bucket, setBucket] = useState(thresholds.length)

  const [observer] = useState(() =>
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries.at(-1)

          if (entry) {
            setBucket(bucketFor(entry.contentRect.width, thresholds))
          }
        }),
  )

  const ref = useCallback(
    (node: T | null) => {
      observer?.disconnect()

      if (node) {
        setBucket(bucketFor(node.getBoundingClientRect().width, thresholds))
        observer?.observe(node)
      }
    },
    [observer, thresholds],
  )

  return [ref, bucket]
}
