import { formatBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../sessions/media'

/** Room left in one request for the goal and the form's own framing. */
const FORM_OVERHEAD_BYTES = 64 * 1024

export const ATTACHMENT_LIMIT_MESSAGE = `Attach up to ${MAX_ATTACHMENTS} nonempty files, totaling less than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`

/**
 * What a paste into a composer adds. Files are attached when they fit; any text on the
 * clipboard is always left for the textarea, since apps such as spreadsheets and slide editors
 * copy text with a picture of it beside, and that text is what the person meant to paste.
 */
export function pasteAttachments(
  current: readonly File[],
  pasted: readonly File[],
  hasText: boolean,
): { files: readonly File[]; error: string | null; takeOver: boolean } {
  if (pasted.length === 0) {
    return { files: current, error: null, takeOver: false }
  }

  const next = [...current, ...pasted]

  const fits =
    next.length <= MAX_ATTACHMENTS &&
    next.reduce((size, file) => size + file.size, 0) <=
      MAX_ATTACHMENT_BYTES - FORM_OVERHEAD_BYTES &&
    next.every((file) => file.size > 0)

  return fits
    ? { files: next, error: null, takeOver: !hasText }
    : { files: current, error: ATTACHMENT_LIMIT_MESSAGE, takeOver: false }
}
