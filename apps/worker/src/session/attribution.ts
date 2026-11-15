import { withAttachmentManifest } from '../assets/sandbox'
import type { AttachmentRef, MessageAuthor } from './scope'

interface SpokenMessage {
  readonly text: string
  readonly author?: MessageAuthor
  readonly attachments?: readonly AttachmentRef[]
}

/**
 * A message as an agent should read it. While only one person has spoken it is the text alone;
 * once several have, each message says who it is from.
 */
export function attributed(message: SpokenMessage, speakerIds: readonly string[]): string {
  return message.author && speakerIds.length > 1
    ? `${message.author.name}: ${message.text}`
    : message.text
}

/**
 * `attributed`, followed by where the message's attached files are saved in the sandbox. Every
 * agent can open a file by path, including those that are never sent the file itself.
 */
export function attributedWithFiles(
  message: SpokenMessage,
  speakerIds: readonly string[],
  runId: string,
): string {
  return withAttachmentManifest(attributed(message, speakerIds), runId, message.attachments)
}
