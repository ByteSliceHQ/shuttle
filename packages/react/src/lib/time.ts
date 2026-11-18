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

/** Compact sidebar stamp: `now`, `1m`, `3h`, `6d`, `2w`, `11mo`, `3y`. */
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

  const days = Math.round(hours / 24)

  if (days < 7) {
    return `${days}d`
  }

  if (days < 30) {
    return `${Math.floor(days / 7)}w`
  }

  if (days < 365) {
    return `${Math.floor(days / 30)}mo`
  }

  return `${Math.floor(days / 365)}y`
}

/** Absolute timestamp for tooltips next to compact stamps. */
export function fullDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
