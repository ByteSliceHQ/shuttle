import type { MessageReferenceInput } from '@shuttle/api'

import { mentionIdentity, mentionToken, splitMentions, type MentionReference } from './tokens'

/**
 * What the message box has picked after `@`, and which of those picks are still in its text.
 */

/**
 * A file or session picked after `@`: what the Worker is sent, and how the message shows it until
 * the Worker's copy arrives. Its text in the message is `mentionToken(shown)`.
 */
export interface MentionPick {
  readonly input: MessageReferenceInput
  readonly shown: MentionReference
}

/** A reference as a pick: from the menu, or read back from the clipboard. */
export function pickOf(reference: MentionReference): MentionPick {
  return reference.kind === 'file'
    ? { input: { kind: 'file', path: reference.path }, shown: reference }
    : {
        input: {
          kind: 'session',
          sessionId: reference.sessionId,
          label: reference.label ?? reference.title,
        },
        shown: reference,
      }
}

/**
 * The picks still in the text, once each, found the way the conversation will find them: longest
 * text first, so deleting `@todo app` leaves `@todo app (2)` its own.
 */
export function picksIn(text: string, picks: readonly MentionPick[]): MentionPick[] {
  const byIdentity = new Map(picks.map((pick) => [mentionIdentity(pick.shown), pick]))
  const references = [...byIdentity.values()].map((pick) => pick.shown)
  const kept = new Map<string, MentionPick>()

  for (const span of splitMentions(text, references)) {
    const identity = span.reference === undefined ? undefined : mentionIdentity(span.reference)
    const pick = identity === undefined ? undefined : byIdentity.get(identity)

    if (identity !== undefined && pick !== undefined) {
      kept.set(identity, pick)
    }
  }

  return [...kept.values()]
}

/** How each pick still in the text is written, for giving a new one text of its own. */
export function labelsInUse(
  text: string,
  picks: readonly MentionPick[],
): { readonly label: string; readonly identity: string }[] {
  return picksIn(text, picks).map((pick) => ({
    label: mentionToken(pick.shown).slice(1),
    identity: mentionIdentity(pick.shown),
  }))
}
