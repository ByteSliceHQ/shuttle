/**
 * Preview keys: the hostname label that leads to a session's preview.
 *
 * A preview runs on its own hostname (`p<port>-<key>.<host>`), where the browser sends no Shuttle
 * sign-in. The key stands in for one: it is random, there is one per session, and only the
 * session's own routes, which check who is asking, give it out.
 */

const KEY_LENGTH = 24
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A random key made of what a hostname label allows. Hostnames ignore case, so it is lowercase. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH))

  // 256 is not a multiple of 36, so the first few characters are slightly likelier. With 24
  // characters that costs a fraction of a bit of the key's 124.
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

export function isPreviewKey(value: string): boolean {
  return value.length === KEY_LENGTH && /^[a-z0-9]+$/.test(value)
}

/** The session's preview key, made the first time it is asked for. */
export async function previewKeyFor(
  db: D1Database,
  runId: string,
  now = Date.now(),
): Promise<string> {
  await db
    .prepare(
      `insert into "shuttle_preview_key" ("key", "run_id", "created_at")
       values (?, ?, ?) on conflict ("run_id") do nothing`,
    )
    .bind(randomKey(), runId, now)
    .run()

  const row = await db
    .prepare(`select "key" from "shuttle_preview_key" where "run_id" = ?`)
    .bind(runId)
    .first<{ key: string }>()

  if (!row) {
    throw new Error('could not create a preview key')
  }

  return row.key
}

/** The session a preview key leads to, or null for anything that is not one. */
export async function runOfPreviewKey(db: D1Database, key: string): Promise<string | null> {
  if (!isPreviewKey(key)) {
    return null
  }

  const row = await db
    .prepare(`select "run_id" from "shuttle_preview_key" where "key" = ?`)
    .bind(key)
    .first<{ run_id: string }>()

  return row?.run_id ?? null
}
