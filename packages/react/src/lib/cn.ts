import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

import type { JsonValue } from '@swirls/looms/core'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function shortId(id: string): string {
  const cut = id.lastIndexOf('_')
  const tail = cut >= 0 ? id.slice(cut + 1) : id
  return tail.length > 8 ? tail.slice(0, 8) : tail
}

export function compactJson(value: JsonValue, limit = 96): string {
  const text = JSON.stringify(value)

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
