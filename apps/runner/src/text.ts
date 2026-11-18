/** The text itself unless it is missing or empty, which both mean "not given". */
export function nonEmpty(text: string | undefined): string | undefined {
  return text === undefined || text === '' ? undefined : text
}
