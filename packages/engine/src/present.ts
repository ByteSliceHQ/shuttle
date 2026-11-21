/** The text, or `undefined` when it is absent or empty. */
export function present(text: string | null | undefined): string | undefined {
  return text === undefined || text === null || text === '' ? undefined : text
}
