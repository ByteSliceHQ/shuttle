#!/usr/bin/env bun
/**
 * Writes the SQL that creates Better Auth's tables, for `wrangler d1 migrations apply`.
 *
 * Run it after changing the auth configuration in `src/auth/auth.ts` (a new plugin, say) and
 * commit the result as a new numbered migration. `src/auth/schema.test.ts` fails when the
 * committed migrations no longer produce the schema the configuration expects.
 */
import { Database } from 'bun:sqlite'

import { getMigrations } from 'better-auth/db/migration'

import { authOptions } from '../src/auth/auth.ts'

export async function authSchemaSql(database = new Database(':memory:')): Promise<string> {
  const options = authOptions(
    { BETTER_AUTH_SECRET: 'schema-generation-only-secret-0123456789' },
    database,
  )

  const { compileMigrations } = await getMigrations(options)

  const sql = (await compileMigrations()).trim()

  // With nothing to create, Better Auth compiles a lone semicolon.
  return sql === ';' ? '' : sql
}

if (import.meta.main) {
  const sql = await authSchemaSql()

  console.log(sql ? `${sql}\n` : '-- The schema is up to date.')
}
