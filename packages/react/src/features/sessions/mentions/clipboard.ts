import { z } from 'zod'

import {
  mentionIdentity,
  mentionToken,
  splitMentions,
  uniqueMentionLabel,
  type MentionReference,
} from './tokens'

/**
 * Copying a message keeps what it points at with `@`. The clipboard gets the text as it is, for
 * anywhere it is pasted, and an HTML copy whose outer element carries the text and its references
 * as JSON. Pasting into Shuttle's message box reads that back, so the mentions arrive as picks
 * and not as text that only looks like them.
 *
 * Whatever is read back is only a suggestion of what to send: the Worker checks every path and
 * every session again, so a clipboard made up elsewhere can claim nothing it could not by typing.
 */

const ATTRIBUTE = 'data-shuttle-mentions'

const ClipboardReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
    title: z.string().min(1),
    label: z.string().min(1).optional(),
  }),
])

const ClipboardMentions = z.object({
  v: z.literal(1),
  text: z.string(),
  references: z.array(ClipboardReference),
})

/** Text and the references in it, as copied and as pasted. */
export interface MentionedText {
  readonly text: string
  readonly references: readonly MentionReference[]
}

/** The references that appear in `text`, once each, in the order they first appear. */
export function referencesInText(
  text: string,
  references: readonly MentionReference[],
): MentionReference[] {
  const found = new Map<string, MentionReference>()

  for (const span of splitMentions(text, references)) {
    if (span.reference !== undefined && !found.has(mentionIdentity(span.reference))) {
      found.set(mentionIdentity(span.reference), span.reference)
    }
  }

  return [...found.values()]
}

/** What goes on the clipboard: the text, and HTML that carries its mentions when it has any. */
export interface MentionClipboard {
  readonly plain: string
  readonly html: string | null
}

/** What to put on the clipboard for `text`: the text itself, and HTML that carries its mentions. */
export function mentionClipboard(
  text: string,
  references: readonly MentionReference[],
): MentionClipboard {
  const present = referencesInText(text, references)

  if (present.length === 0) {
    return { plain: text, html: null }
  }

  const payload = JSON.stringify({ v: 1, text, references: present })
  const body = escapeHtml(text).replaceAll('\n', '<br>')

  return { plain: text, html: `<span ${ATTRIBUTE}="${escapeHtml(payload)}">${body}</span>` }
}

/**
 * The text and mentions a clipboard carries, or null when it carries none of Shuttle's. The plain
 * text has to be what was copied: an editor that kept the HTML but changed the words loses them.
 */
export function readMentionClipboard(html: string, plain: string): MentionedText | null {
  const match = new RegExp(`${ATTRIBUTE}="([^"]*)"`).exec(html)
  const encoded = match?.[1]

  if (encoded === undefined) {
    return null
  }

  let decoded: unknown

  try {
    decoded = JSON.parse(unescapeHtml(encoded))
  } catch {
    return null
  }

  const parsed = ClipboardMentions.safeParse(decoded)

  if (!parsed.success || normalizeNewlines(parsed.data.text) !== normalizeNewlines(plain)) {
    return null
  }

  return {
    text: parsed.data.text,
    references: referencesInText(parsed.data.text, parsed.data.references),
  }
}

/**
 * Pasted mentions fitted to the message they land in. A session already mentioned keeps the way
 * it is written there, and one whose text would mean another session gets a number, so every
 * mention in the message still links to what it pointed at when it was copied.
 */
export function fitPastedMentions(
  pasted: MentionedText,
  inUse: readonly { readonly label: string; readonly identity: string }[],
): MentionedText {
  const taken = [...inUse]

  const fitted = pasted.references.map((reference) => {
    if (reference.kind === 'file') {
      return { from: reference, to: reference }
    }

    const identity = mentionIdentity(reference)
    const label = uniqueMentionLabel(reference.title, identity, taken)

    taken.push({ label, identity })

    return { from: reference, to: { ...reference, label } }
  })

  const rewritten = new Map(fitted.map(({ from, to }) => [mentionIdentity(from), to]))

  const text = splitMentions(pasted.text, pasted.references)
    .map((span) => {
      const to =
        span.reference === undefined ? undefined : rewritten.get(mentionIdentity(span.reference))

      return to === undefined ? span.text : mentionToken(to)
    })
    .join('')

  return { text, references: fitted.map(({ to }) => to) }
}

/**
 * Puts `text` on the clipboard, with its mentions where something can read them back. Where the
 * page may not write the clipboard itself (an embedded frame, an older browser), the browser's
 * own copy command carries both formats instead. Rejects only when neither could copy.
 */
export async function copyMentionedText(
  text: string,
  references: readonly MentionReference[],
): Promise<void> {
  const { plain, html } = mentionClipboard(text, references)

  try {
    await writeClipboard(plain, html)
    return
  } catch (cause) {
    if (!copyWithCommand(plain, html)) {
      throw cause
    }
  }
}

async function writeClipboard(plain: string, html: string | null): Promise<void> {
  if (html === null || typeof ClipboardItem === 'undefined') {
    await navigator.clipboard.writeText(plain)
    return
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    }),
  ])
}

/** Copies through `document.execCommand('copy')`, filling in the copy event it fires. */
function copyWithCommand(plain: string, html: string | null): boolean {
  const fill = (event: ClipboardEvent) => {
    event.preventDefault()
    event.clipboardData?.setData('text/plain', plain)

    if (html !== null) {
      event.clipboardData?.setData('text/html', html)
    }
  }

  document.addEventListener('copy', fill)

  try {
    // oxlint-disable-next-line typescript/no-deprecated -- SAFETY: only reached when the Clipboard API refused; nothing replaces the command for that case.
    return document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', fill)
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function unescapeHtml(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#34;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n')
}
