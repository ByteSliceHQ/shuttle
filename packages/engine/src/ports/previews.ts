/**
 * Preview keys: the host port for the hostname label that leads to a session's preview.
 *
 * A preview runs on its own hostname (`p<port>-<key>.<host>`), where a browser sends no sign-in.
 * The key stands in for one, so it has to be kept: one per session, found again from the
 * hostname. Shuttle's own app keeps them in its database. A host with no port has no previews.
 */
export interface PreviewKeys {
  /** The session's key, made the first time it is asked for. */
  keyFor(runId: string): Promise<string>
  /** The session a key leads to, or null for anything that is not one. */
  runOf(key: string): Promise<string | null>
}
