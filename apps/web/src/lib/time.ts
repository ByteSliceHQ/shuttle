/** Run ids start with a base36 millisecond timestamp (`run_<ms36>_<counter>_<entropy>`). */
export function runCreatedAt(runId: string): number | undefined {
  const stamp = runId.split('_')[1]

  if (!stamp) {
    return undefined
  }

  const ms = Number.parseInt(stamp, 36)
  return Number.isFinite(ms) ? ms : undefined
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))

  if (seconds < 45) {
    return 'just now'
  }

  const minutes = Math.round(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  return `${Math.round(hours / 24)}d ago`
}

/** Compact sidebar stamp: `1m`, `3h`, `1d`. */
export function compactRelativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))

  if (seconds < 45) {
    return 'now'
  }

  const minutes = Math.round(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h`
  }

  return `${Math.round(hours / 24)}d`
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
