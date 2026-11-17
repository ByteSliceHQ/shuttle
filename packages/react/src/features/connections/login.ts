import type { LoginEvent, LoginProgress } from '@shuttle/api'

/** The page to open, and the code to enter there or bring back, as the vendor CLI printed it. */
export type LoginPrompt = Extract<LoginEvent, { type: 'login_prompt' }>

/** Where a sign-in stands, from everything it has said so far. */
export type LoginOutcome =
  | { readonly status: 'waiting'; readonly prompt: LoginPrompt | null }
  | { readonly status: 'connected' }
  | { readonly status: 'failed'; readonly error: string }

/**
 * Adds a read made from `soFar.offset` to what earlier reads returned. The result is what one
 * read from the start would have returned: every event once, in order, with the newest offset.
 * An event already held is left out, so making the same read twice changes nothing.
 */
export function mergeProgress(
  soFar: LoginProgress | undefined,
  page: LoginProgress,
): LoginProgress {
  if (!soFar) {
    return page
  }

  const last = soFar.events.at(-1)?.seq ?? 0

  return { ...page, events: [...soFar.events, ...page.events.filter((event) => event.seq > last)] }
}

export function loginOutcome(progress: LoginProgress): LoginOutcome {
  const failure = progress.events.find((event) => event.type === 'login_done' && !event.success)

  if (failure?.type === 'login_done') {
    return { status: 'failed', error: failure.error ?? 'Sign-in did not complete.' }
  }

  if (progress.connected) {
    return { status: 'connected' }
  }

  if (progress.error) {
    return { status: 'failed', error: progress.error }
  }

  // Ended without connecting the agent or saying why. Nothing follows, so waiting would never end.
  if (progress.done) {
    return { status: 'failed', error: 'Sign-in did not complete.' }
  }

  // The CLI can ask again, after a wrong code for one. Only its latest prompt still stands.
  const prompt = progress.events.findLast((event) => event.type === 'login_prompt')

  return { status: 'waiting', prompt: prompt?.type === 'login_prompt' ? prompt : null }
}

/** True once nothing more will come of the sign-in, so there is nothing left to ask for. */
export function loginSettled(progress: LoginProgress): boolean {
  return loginOutcome(progress).status !== 'waiting'
}
