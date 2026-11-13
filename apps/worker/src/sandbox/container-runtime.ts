/** Keep agent-started servers alive across DO idle gaps (Cloudflare default is near-immediate stop). */
export const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000

export type DurableContainer = NonNullable<DurableObjectState['container']>

/** Start the DO container if needed and extend its inactivity timeout. */
export async function ensureContainerRunning(
  container: DurableContainer | undefined,
): Promise<DurableContainer> {
  if (!container) {
    throw new Error('SessionSandbox container binding is not configured')
  }

  if (!container.running) {
    container.start({
      image: container.images.base,
      entrypoint: ['sleep', 'infinity'],
      // The image carries the vendor agent CLIs (about 3 GB), which does not fit the smaller
      // instance disks once repositories are cloned.
      instance: 'standard-1',
      enableInternet: true,
    })
  }

  await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
  return container
}

export function reapplyInactivityTimeout(ctx: DurableObjectState): void {
  const container = ctx.container

  if (container?.running) {
    void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS))
  }
}

export function requireContainerMode(
  mode: 'memory' | 'container',
  container: DurableContainer | undefined,
): DurableContainer | Response {
  if (mode !== 'container' || !container) {
    return Response.json({ error: 'container-mode-required' }, { status: 501 })
  }

  return container
}
