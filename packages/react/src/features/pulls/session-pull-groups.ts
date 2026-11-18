import type { PublishedPull } from '../sessions/session-feed'

export interface SessionPullStack {
  readonly key: string
  readonly fullName: string
  /** Top layer first. */
  readonly layers: readonly PublishedPull[]
}

export interface SessionPullGroups {
  readonly stacks: readonly SessionPullStack[]
  /** One-layer stacks and PRs Shuttle can't place, in input order. */
  readonly standalone: readonly PublishedPull[]
}

/** Split a session's PRs into real stacks (2+ layers) and standalone PRs. */
export function groupSessionPulls(pulls: readonly PublishedPull[]): SessionPullGroups {
  const byStack = new Map<string, PublishedPull[]>()

  for (const pull of pulls) {
    if (pull.stack) {
      const key = `${pull.fullName}#${pull.stack.id}`
      byStack.set(key, [...(byStack.get(key) ?? []), pull])
    }
  }

  const stacks: SessionPullStack[] = []
  const stacked = new Set<PublishedPull>()

  for (const [key, layers] of byStack) {
    const [first] = layers

    if (first === undefined || layers.length < 2) {
      continue
    }

    for (const layer of layers) {
      stacked.add(layer)
    }

    stacks.push({
      key,
      fullName: first.fullName,
      layers: layers.toSorted((a, b) => (b.stack?.layer ?? 0) - (a.stack?.layer ?? 0)),
    })
  }

  return {
    stacks: stacks.toSorted((a, b) => a.key.localeCompare(b.key)),
    standalone: pulls.filter((pull) => !stacked.has(pull)),
  }
}
