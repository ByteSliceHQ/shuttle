/** How many closed pull requests the inbox and the thread keep. Open ones are always kept. */
export const MAX_RETAINED_CLOSED_PULLS = 100

type Retained = {
  readonly state: 'open' | 'closed'
  readonly updatedAt: number
}

/**
 * Drops the oldest closed pull requests past `MAX_RETAINED_CLOSED_PULLS`. Without it the pulls
 * object folds every pull request the organization ever had, each with its whole body, into the
 * state it keeps in memory between requests.
 */
export function retainPulls<Pull extends Retained>(
  pulls: Readonly<Record<string, Pull>>,
): Readonly<Record<string, Pull>> {
  const closed = Object.entries(pulls).filter(([, pull]) => pull.state === 'closed')

  if (closed.length <= MAX_RETAINED_CLOSED_PULLS) {
    return pulls
  }

  const kept = new Set(
    closed
      .toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_RETAINED_CLOSED_PULLS)
      .map(([key]) => key),
  )

  return Object.fromEntries(
    Object.entries(pulls).filter(([key, pull]) => pull.state === 'open' || kept.has(key)),
  )
}
