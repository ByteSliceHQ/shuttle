import type { ReactNode } from 'react'

/** True when a value holds some text: it is neither missing nor the empty string. */
export function hasText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== ''
}

/** True when a React node would draw something: it is not missing, null, a boolean or empty text. */
export function hasNode(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== true && node !== false && node !== ''
}
