import type { LlmCompleteArgs } from '@swirls/looms/agent'

import { readSessionAccess } from '../tenancy/access'

/**
 * Whose sign-in a session's vendor agents run on: the person who most recently gave it work.
 *
 * A task or correction reaches an agent as a user message named after its author (see
 * `route-effects.ts`). The agent thread takes one such message at a time, so the latest one in a
 * turn's messages is the person that turn is working for. Until anyone has asked for something,
 * that is the session's owner.
 *
 * The answer is remembered, because the agents a conductor delegates to see only the conductor's
 * instructions, with nobody's name on them.
 */

export const SPONSOR_STORAGE_KEY = 'shuttle:sponsor'

type SponsorStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/** The author of the latest message in `messages` that asked for work, if any did. */
export function sponsorOfMessages(messages: LlmCompleteArgs['messages']): string | null {
  const asked = messages.toReversed().find((message) => message.role === 'user' && message.name)

  return asked?.name ?? null
}

/** The current sponsor, without looking at a turn: the remembered one, else the owner. */
export async function readSponsor(storage: SponsorStorage): Promise<string | null> {
  const remembered = await storage.get<string>(SPONSOR_STORAGE_KEY)

  return remembered ?? (await readSessionAccess(storage))?.ownerId ?? null
}

/** The sponsor of the turn that `messages` belongs to, remembered for the turns it delegates. */
export async function resolveSponsor(
  storage: SponsorStorage,
  messages: LlmCompleteArgs['messages'],
): Promise<string | null> {
  const asked = sponsorOfMessages(messages)

  if (!asked) {
    return readSponsor(storage)
  }

  if ((await storage.get<string>(SPONSOR_STORAGE_KEY)) !== asked) {
    await storage.put(SPONSOR_STORAGE_KEY, asked)
  }

  return asked
}
