import { z } from 'zod'

/**
 * What a session's digest is made from, when another session's message points at it: its brief
 * and the last few things its agents said. Read by the session's own Durable Object, so only
 * these few lines leave it and not the whole transcript.
 */

/** Longest the brief and each agent message are kept, in characters. */
export const BRIEF_CHARS = 2_000
export const REPLY_CHARS = 1_200
/** How many of the latest agent messages are kept. */
export const REPLIES = 2

export interface DigestSource {
  readonly brief: string
  /** The latest agent messages that say something, oldest first. */
  readonly replies: readonly string[]
}

const BriefProjection = z.object({
  value: z.object({ text: z.string() }).nullish(),
})

const TranscriptProjection = z.object({
  value: z
    .object({ messages: z.array(z.object({ role: z.string(), text: z.string() })) })
    .nullish(),
})

/** Reads the digest's source from the session's `brief` and `transcript` projections. */
export async function readDigestSource(
  projection: (name: 'brief' | 'transcript') => Promise<Response>,
): Promise<DigestSource> {
  const body = (name: 'brief' | 'transcript') =>
    projection(name)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)

  const [brief, transcript] = await Promise.all([body('brief'), body('transcript')])
  const messages = TranscriptProjection.safeParse(transcript).data?.value?.messages ?? []

  return {
    brief: clip(BriefProjection.safeParse(brief).data?.value?.text ?? '', BRIEF_CHARS),
    replies: messages
      // Turns that only called tools leave empty messages; they say nothing to quote.
      .filter((message) => message.role === 'assistant' && message.text.trim() !== '')
      .slice(-REPLIES)
      .map((message) => clip(message.text, REPLY_CHARS)),
  }
}

export function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}
