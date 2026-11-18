import { z } from 'zod'

/** What a browser terminal sends over its WebSocket: typed text, raw bytes, or a resize. */
export type TerminalInput =
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }

const socketData = z.union([z.string(), z.instanceof(ArrayBuffer)])
const resizeMessage = z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() })

/** Decodes one WebSocket message from the browser; null when it is neither text nor bytes. */
export function terminalInput(event: MessageEvent): TerminalInput | null {
  const data = socketData.safeParse(event.data)

  if (!data.success) {
    return null
  }

  if (data.data instanceof ArrayBuffer) {
    return { kind: 'bytes', bytes: new Uint8Array(data.data) }
  }

  const text = data.data

  if (text.startsWith('{')) {
    try {
      const resize = resizeMessage.safeParse(JSON.parse(text))

      if (resize.success) {
        return { kind: 'resize', cols: resize.data.cols, rows: resize.data.rows }
      }
    } catch {
      // Not a control message: it is typed input.
    }
  }

  return { kind: 'text', text }
}
