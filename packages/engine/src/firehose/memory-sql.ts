import { Database } from 'bun:sqlite'

import type { FirehoseCursor, FirehoseSql, FirehoseSqlRow } from './store'

/**
 * In-memory SqlStorage stand-in for unit tests.
 * Mimics Durable Object `storage.sql.exec` enough for the firehose store.
 */
export function createMemoryFirehoseSql(): FirehoseSql {
  const db = new Database(':memory:')

  return {
    exec(query: string, ...bindings: SqlStorageValue[]): FirehoseCursor {
      const statements = query
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)

      let rowsWritten = 0
      let rows: FirehoseSqlRow[] = []

      for (const statement of statements) {
        const stmt = db.prepare<FirehoseSqlRow, SqlStorageValue[]>(statement)
        const isQuery = /^\s*(SELECT|WITH)\b/i.test(statement)

        if (isQuery) {
          rows = stmt.all(...bindings)
          rowsWritten = 0
        } else {
          rowsWritten = stmt.run(...bindings).changes
          rows = []
        }
      }

      return {
        rowsWritten,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      }
    },
  }
}
