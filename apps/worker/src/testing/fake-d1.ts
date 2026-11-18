import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

type Binding = string | number | bigint | boolean | null | Uint8Array

const RowsSchema = z.array(
  z.record(
    z.string(),
    z.union([z.string(), z.number(), z.bigint(), z.null(), z.instanceof(Uint8Array)]),
  ),
)

const ChangeSchema = z.object({ changes: z.number(), id: z.number() })

interface FakeResult {
  readonly results: z.infer<typeof RowsSchema>
  readonly success: boolean
  readonly meta: {
    readonly changes: number
    readonly last_row_id: number
    readonly duration: number
  }
}

interface FakeStatement {
  all(): Promise<FakeResult>
}

/**
 * A D1 database for unit tests, backed by an in-memory SQLite database. It covers the part of
 * the D1 API that Shuttle and Better Auth use.
 */
export function fakeD1(sqlite = new Database(':memory:')): D1Database {
  const statement = (sql: string, bindings: readonly Binding[] = []) => {
    const all = () => {
      const query = sqlite.query(sql)
      const results = RowsSchema.parse(query.all(...bindings))

      const meta = ChangeSchema.parse(
        sqlite.query('select changes() as changes, last_insert_rowid() as id').get(),
      )

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
        const row = all().results[0]

        if (row === undefined) {
          return null
        }

        return column === undefined ? row : (row[column] ?? null)
      },
      raw: async () => all().results.map((row) => Object.values(row)),
    }
  }

  const database = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: readonly FakeStatement[]) => {
      const results: FakeResult[] = []

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

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: the fake answers prepare, batch and exec, the whole D1 surface Shuttle and Better Auth call; D1's generic row types cannot be implemented without naming the caller's type.
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
