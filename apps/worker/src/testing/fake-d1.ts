import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Binding = string | number | bigint | boolean | null | Uint8Array

/**
 * A D1 database for unit tests, backed by an in-memory SQLite database. It covers the part of
 * the D1 API that Shuttle and Better Auth use.
 */
export function fakeD1(sqlite = new Database(':memory:')): D1Database {
  const statement = (sql: string, bindings: readonly Binding[] = []) => {
    const all = () => {
      const query = sqlite.query(sql)
      const results = query.all(...bindings)
      const changed = sqlite.query('select changes() as changes, last_insert_rowid() as id').get()

      const meta = changed as { changes: number; id: number }

      return {
        results,
        success: true,
        meta: { changes: meta.changes, last_row_id: meta.id, duration: 0 },
      }
    }

    return {
      bind: (...next: Binding[]) => statement(sql, next),
      all: async () => all(),
      run: async () => all(),
      first: async (column?: string) => {
        const row = all().results[0] as Record<string, unknown> | undefined

        if (!row) {
          return null
        }

        return column ? (row[column] ?? null) : row
      },
      raw: async () => all().results.map((row) => Object.values(row as object)),
    }
  }

  const database = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: readonly { all(): Promise<unknown> }[]) => {
      const results = []

      for (const item of statements) {
        results.push(await item.all())
      }

      return results
    },
    exec: async (sql: string) => {
      sqlite.run(sql)
      return { count: 1, duration: 0 }
    },
  }

  return database as unknown as D1Database
}

/** A fake D1 database with every committed migration applied, as `wrangler d1 migrations` would. */
export async function migratedD1(): Promise<D1Database> {
  const directory = join(import.meta.dir, '../../migrations')
  const database = fakeD1()

  for (const file of readdirSync(directory).toSorted()) {
    if (file.endsWith('.sql')) {
      await database.exec(readFileSync(join(directory, file), 'utf8'))
    }
  }

  return database
}
