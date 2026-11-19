import { worktreeRoot } from '../sandbox/workspace'
import type { MessageReference } from './scope'

/**
 * What a message's `@` references say to an agent, under the message: where each file is, and
 * what each other session is about. Empty when there are none.
 */
export function referenceManifest(
  runId: string,
  references: readonly MessageReference[] | undefined,
): string {
  const files: string[] = []
  const sessions: string[] = []

  for (const reference of references ?? []) {
    if (reference.kind === 'file') {
      files.push(`- ${reference.path}: ${worktreeRoot(runId)}/${reference.path}`)
      continue
    }

    const digest = (reference.digest ?? '').trim()

    // Two sessions can share a title; the text it is written as tells the agent which is which.
    const written =
      reference.label !== undefined && reference.label !== reference.title
        ? `, written as @${reference.label}`
        : ''

    const heading = `- "${reference.title}" (${reference.sessionId})${written}`

    sessions.push(digest === '' ? heading : `${heading}\n${indent(digest)}`)
  }

  return [
    files.length > 0
      ? `Files the message points at, in the session's worktree:\n${files.join('\n')}`
      : '',
    sessions.length > 0
      ? `Other sessions the message points at. You cannot open them; this is what they say:\n${sessions.join('\n')}`
      : '',
  ]
    .filter((block) => block !== '')
    .join('\n\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}
