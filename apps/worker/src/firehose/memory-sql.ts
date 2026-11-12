import { Database } from 'bun:sqlite'

import type { FirehoseSql } from './store'

type FirehoseCursor = SqlStorageCursor<Record<string, SqlStorageValue>>

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

      let lastChanges = 0
      let lastRows: Record<string, SqlStorageValue>[] = []

      for (const statement of statements) {
        const stmt = db.prepare(statement)
        const isQuery = /^\s*(SELECT|WITH)\b/i.test(statement)

        if (isQuery) {
          lastRows = stmt.all(...bindings) as Record<string, SqlStorageValue>[]
          lastChanges = 0
        } else {
          const result = stmt.run(...bindings)
          lastChanges = result.changes
          lastRows = []
        }
      }

      const rows = lastRows
      let index = 0

      const cursor = {
        next() {
          if (index >= rows.length) {
            return { done: true as const, value: undefined }
          }

          const value = rows[index++]
          return { done: false as const, value }
        },
        [Symbol.iterator]() {
          return cursor
        },
        toArray() {
          return rows.slice(index)
        },
        one() {
          return rows[index] ?? null
        },
        raw() {
          return cursor
        },
        columnNames: rows[0] ? Object.keys(rows[0]) : [],
        get rowsRead() {
          return rows.length
        },
        get rowsWritten() {
          return lastChanges
        },
      }

      return cursor as unknown as FirehoseCursor
    },
  }
}
