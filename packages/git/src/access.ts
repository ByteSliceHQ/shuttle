/**
 * How Shuttle gets a credential to act on a GitHub repository: the host port for Git and GitHub
 * access.
 *
 * Every GitHub call Shuttle makes for a repository, and every clone a sandbox does, asks for an
 * installation token. With no port supplied the token is minted from Shuttle's own GitHub App
 * (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`), which is how a standalone Shuttle has always
 * worked. A host that already brokers GitHub access, with its own App or its own tokens, supplies
 * a `GitAccess` and Shuttle never sees an App key.
 */
export interface GitAccess {
  /** A token that can act on `installationId`'s repositories. Called for each GitHub request. */
  installationToken(installationId: number): Promise<string>
  /**
   * A person's own token, tried when the installation token is refused: pull request sync and
   * creation where the App lacks scopes. Null when there is none.
   */
  userToken?(): string | null
}

/** A `GitAccess` that answers every installation with `token`. For tests and single-token hosts. */
export function fixedGitAccess(token: string): GitAccess {
  return {
    installationToken: async () => token,
    userToken: () => token,
  }
}
