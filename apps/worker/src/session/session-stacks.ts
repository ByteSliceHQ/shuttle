import type { SessionStacks } from './stack-state'

export const SESSION_STACKS_KEY = 'shuttle:session-stacks'

const memoryStacks = new Map<string, SessionStacks>()

export async function writeSessionStacks(
  storage: DurableObjectStorage | undefined,
  runId: string,
  stacks: SessionStacks,
): Promise<void> {
  if (storage) {
    await storage.put(SESSION_STACKS_KEY, stacks)
    return
  }

  memoryStacks.set(runId, stacks)
}

export async function readSessionStacks(
  storage: DurableObjectStorage | undefined,
  runId: string,
): Promise<SessionStacks> {
  if (storage) {
    const value = await storage.get<SessionStacks>(SESSION_STACKS_KEY)
    return value ?? {}
  }

  return memoryStacks.get(runId) ?? {}
}
