import type { JsonValue } from '@swirls/looms/core'

import { jsonFields, jsonText } from '../../../lib/json'
import { hasText } from '../../../lib/text'

/**
 * What a message points at with `@`, as the conversation and the message box show it, and how to
 * find each one's text in the message.
 */

/**
 * A file (by its path in the session's worktree) or another session, as a message names it. A
 * session's `label` is the text it was written as after `@`: its title, or its title with a number
 * when another picked session has the same one. Absent on messages from before labels.
 */
export type MentionReference =
  | { readonly kind: 'file'; readonly path: string }
  | {
      readonly kind: 'session'
      readonly sessionId: string
      readonly title: string
      readonly label?: string
    }

/** The text a reference is written as in a message: `@` and its path, or its label or title. */
export function mentionToken(reference: MentionReference): string {
  return `@${reference.kind === 'file' ? reference.path : (reference.label ?? reference.title)}`
}

/** What a reference points at, the same for every mention of it. */
export function mentionIdentity(reference: MentionReference): string {
  return reference.kind === 'file' ? `file:${reference.path}` : `session:${reference.sessionId}`
}

/**
 * The label to write a newly picked reference as, so that no two different things in one message
 * are written the same way. Something already mentioned is written as it was; otherwise `base`,
 * or `base (2)`, `base (3)`… when that text already means something else.
 */
export function uniqueMentionLabel(
  base: string,
  identity: string,
  inUse: readonly { readonly label: string; readonly identity: string }[],
): string {
  const same = inUse.find((entry) => entry.identity === identity)

  if (same !== undefined) {
    return same.label
  }

  const taken = new Set(inUse.map((entry) => entry.label))
  let label = base

  for (let copy = 2; taken.has(label); copy++) {
    label = `${base} (${copy})`
  }

  return label
}

/** The references recorded on a message, leaving out any that are not in a shape this knows. */
export function mentionReferencesOf(value: JsonValue | undefined): MentionReference[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item): MentionReference[] => {
    const fields = jsonFields(item)
    const kind = jsonText(fields.kind)

    if (kind === 'file') {
      const path = jsonText(fields.path)

      return hasText(path) ? [{ kind, path }] : []
    }

    if (kind === 'session') {
      const sessionId = jsonText(fields.sessionId)
      const title = jsonText(fields.title)
      const label = jsonText(fields.label)

      if (!hasText(sessionId) || !hasText(title)) {
        return []
      }

      return [hasText(label) ? { kind, sessionId, title, label } : { kind, sessionId, title }]
    }

    return []
  })
}

/** A run of a message's text, plain or the text of one reference, and where it starts in it. */
export type MentionSpan =
  | { readonly start: number; readonly text: string; readonly reference?: undefined }
  | { readonly start: number; readonly text: string; readonly reference: MentionReference }

/** A character that can carry on a word or path, so a token followed by one is not a whole match. */
const CONTINUES = /[\p{L}\p{N}_/]/u

/**
 * `text` cut into plain runs and the runs that are a reference's token. Where two tokens start at
 * the same `@`, the longer wins, so `@web/app.ts` is not read as `@web`.
 */
export function splitMentions(
  text: string,
  references: readonly MentionReference[],
): MentionSpan[] {
  if (references.length === 0) {
    return text === '' ? [] : [{ start: 0, text }]
  }

  const tokens = references
    .map((reference) => ({ token: mentionToken(reference), reference }))
    .toSorted((a, b) => b.token.length - a.token.length)

  const spans: MentionSpan[] = []
  let plainFrom = 0
  let at = text.indexOf('@')

  while (at !== -1) {
    const found = tokens.find(
      ({ token }) => text.startsWith(token, at) && !CONTINUES.test(text.charAt(at + token.length)),
    )

    if (found === undefined) {
      at = text.indexOf('@', at + 1)
      continue
    }

    if (at > plainFrom) {
      spans.push({ start: plainFrom, text: text.slice(plainFrom, at) })
    }

    spans.push({ start: at, text: found.token, reference: found.reference })
    plainFrom = at + found.token.length
    at = text.indexOf('@', plainFrom)
  }

  if (plainFrom < text.length) {
    spans.push({ start: plainFrom, text: text.slice(plainFrom) })
  }

  return spans
}
