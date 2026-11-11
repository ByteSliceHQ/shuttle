/**
 * Build `timeout … bash -lc <script>` argv without re-quoting the script.
 *
 * The script must stay a real argv element (real newlines intact). Embedding it
 * via `JSON.stringify` into `bash -lc "..."` turns `\n` into a literal
 * backslash-n, so `rm a\ncat b` collapses to `rm ancat b` and deletes `b`.
 */
export function timedBashArgv(command: string, timeoutSeconds: number): string[] {
  const seconds = Math.max(1, Math.floor(timeoutSeconds))
  return ['timeout', '-k', '5', String(seconds), 'bash', '-lc', command]
}

/** POSIX single-quote a value for interpolation into a bash script. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
