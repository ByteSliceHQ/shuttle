import type { GitAccess } from './access'

/**
 * What the Git and GitHub code reads from a host's configuration. All of it is optional: a host
 * that sets none of it can still use the parts that do not need GitHub.
 */
export interface GitEnv {
  readonly GITHUB_APP_ID?: string
  readonly GITHUB_APP_SLUG?: string
  readonly GITHUB_APP_PRIVATE_KEY?: string
  readonly GITHUB_STATE_SECRET?: string
  readonly GITHUB_WEBHOOK_SECRET?: string
  /**
   * Optional user/PAT token. Used when the GitHub App lacks `pull_requests`
   * (and related) scopes so local inbox sync and PR create still work.
   */
  readonly GITHUB_TOKEN?: string
  /** Code Storage organization name and signing key. */
  readonly PIERRE_ORG?: string
  readonly PIERRE_PRIVATE_KEY?: string
  /**
   * The host's own Git and GitHub access. When set, installation tokens come from it and the
   * GitHub App settings above are not used for them. See `access.ts`.
   */
  readonly GIT_ACCESS?: GitAccess
  /**
   * Shuttle's sign-in database, where a person's linked GitHub account is found so the commits
   * they approve are credited to them. Without it commits are credited to the GitHub App.
   */
  readonly AUTH_DB?: D1Database
}
