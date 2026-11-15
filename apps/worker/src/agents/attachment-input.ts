import { z } from 'zod'

/** A file attached to the message an agent starts on. Looms puts it on the agent's first line. */
export const AttachmentInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
})
