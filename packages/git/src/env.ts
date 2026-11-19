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
}
