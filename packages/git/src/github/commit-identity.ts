import { z } from 'zod'

import type { GitEnv } from '../env'
import { githubFetch } from './client'

/** The name and email a commit is credited to. */
export interface CommitIdentity {
  readonly name: string
  readonly email: string
}

const GithubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
})

const AccountRowSchema = z.object({ accountId: z.string() })

/**
 * The commit identity of a Shuttle user's linked GitHub account: their profile name (or login),
 * and the no-reply address GitHub gives every account. That address always leads back to the
 * account, so GitHub shows the commit as theirs whichever emails they have verified.
 *
 * Null when the person has no GitHub account linked, or GitHub cannot say who it is. The commit
 * is then credited to the App, as it was before.
 */
export async function commitIdentityOf(
  env: GitEnv,
  userId: string,
  token: string,
): Promise<CommitIdentity | null> {
  const db = env.AUTH_DB

  if (db === undefined) {
    return null
  }

  const row = AccountRowSchema.safeParse(
    await db
      .prepare(
        `select "accountId" from "account" where "userId" = ? and "providerId" = 'github' limit 1`,
      )
      .bind(userId)
      .first(),
  )

  if (!row.success || !/^\d+$/.test(row.data.accountId)) {
    return null
  }

  const response = await githubFetch(env, `/user/${row.data.accountId}`, { token })

  if (!response.ok) {
    return null
  }

  const user = GithubUserSchema.safeParse(await response.json().catch(() => null))

  if (!user.success) {
    return null
  }

  const { id, login, name } = user.data

  return {
    name: name !== undefined && name !== null && name.trim() !== '' ? name : login,
    email: `${id}+${login}@users.noreply.github.com`,
  }
}
