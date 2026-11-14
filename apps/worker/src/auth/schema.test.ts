import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { authSchemaSql } from '../../scripts/auth-schema'

test('the committed migrations create the schema the auth configuration expects', async () => {
  const directory = join(import.meta.dir, '../../migrations')
  const database = new Database(':memory:')

  for (const file of readdirSync(directory).toSorted()) {
    database.exec(readFileSync(join(directory, file), 'utf8'))
  }

  // Anything left to create means the configuration changed without a new migration. Run
  // `bun scripts/auth-schema.ts` and commit its output as the next numbered migration.
  expect(await authSchemaSql(database)).toBe('')
})
