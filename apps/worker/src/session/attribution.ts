import type { MessageAuthor } from './scope'

/**
 * A message as an agent should read it. While only one person has spoken it is the text alone;
 * once several have, each message says who it is from.
 */
export function attributed(
  message: { readonly text: string; readonly author?: MessageAuthor },
  speakerIds: readonly string[],
): string {
  return message.author && speakerIds.length > 1
    ? `${message.author.name}: ${message.text}`
    : message.text
}
