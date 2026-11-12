/**
 * Decide which stack layers need to be mirrored to GitHub.
 *
 * A layer must republish when its local tree differs from the last published tree.
 * Every layer above that also republishes, because their parent commit SHA changes.
 */

export interface PlannedLayer {
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  /** Local tip tree SHA. */
  readonly localTree: string
  /** Last tree SHA published for this layer, if any. */
  readonly publishedTree: string | null
  readonly reason: 'new' | 'changed' | 'cascade'
}

export interface StackLayerSnapshot {
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  readonly localTree: string
  readonly publishedTree: string | null
}

/**
 * Returns the contiguous suffix of layers that must be mirrored, lowest first.
 * Empty when every layer's local tree matches its published tree.
 */
export function planStackPublish(layers: readonly StackLayerSnapshot[]): readonly PlannedLayer[] {
  if (layers.length === 0) {
    return []
  }

  let lowest: number | null = null

  for (const layer of layers) {
    if (layer.publishedTree === null || layer.localTree !== layer.publishedTree) {
      lowest = layer.layer
      break
    }
  }

  if (lowest === null) {
    return []
  }

  return layers
    .filter((layer) => layer.layer >= lowest)
    .map((layer) => ({
      layer: layer.layer,
      branch: layer.branch,
      parentBranch: layer.parentBranch,
      localTree: layer.localTree,
      publishedTree: layer.publishedTree,
      reason:
        layer.publishedTree === null
          ? ('new' as const)
          : layer.localTree !== layer.publishedTree
            ? ('changed' as const)
            : ('cascade' as const),
    }))
}
