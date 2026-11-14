import { shellQuote } from './exec-argv'
import { repoCheckoutPath, worktreeRepoPath, type ExecOptions, type ExecResult } from './workspace'

/**
 * Moves a session's work between sandboxes through a git remote.
 *
 * `snapshotSession` records everything in a session's worktree for one repository (its branches,
 * and the uncommitted and untracked files on top of the one checked out) and pushes it to the
 * session's own branches on the remote. `restoreSession` rebuilds the same worktree somewhere
 * else from that. The branch, the index and the working files end up as they were: a snapshot is
 * not a commit on the session's branch, and restoring one does not create any.
 *
 * Ignored files (dependencies, build output) are not carried. They are rebuilt where needed.
 */

export interface SyncHost {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
}

/** A git remote and the credential for it, as `repo-access.ts` hands them out. */
export interface SyncRemote {
  readonly url: string
  readonly basicAuth: string
}

export interface SessionSnapshot {
  readonly repoName: string
  /** The branch that was checked out. */
  readonly head: string
  readonly headSha: string
  /** A commit on top of `headSha` whose tree is the working directory as it stood. */
  readonly snapshotSha: string
  /** Every branch the session has in this repository. */
  readonly branches: readonly { readonly name: string; readonly sha: string }[]
  /** Git config the stack tools keep per branch (base commit, layer, parent). */
  readonly config: readonly { readonly key: string; readonly value: string }[]
}

const SYNC_TIMEOUT_MS = 300_000

/** Where a session's branches and working snapshot live on the remote. */
export function sessionRemoteRefs(runId: string, repoName: string) {
  return {
    branches: `refs/heads/sessions/${runId}/b/`,
    work: `refs/heads/sessions/${runId}/w/${repoName}`,
  }
}

/**
 * The remote name for one of the session's branches. Local branches are `shuttle/<runId>…`, and
 * the remote ones already sit under the run id, so it is not repeated: Code Storage refuses a
 * ref name that long.
 */
export function remoteBranchRef(runId: string, repoName: string, branch: string): string {
  const prefix = `shuttle/${runId}`
  const rest = branch.startsWith(prefix) ? branch.slice(prefix.length) : `/${branch}`

  return `${sessionRemoteRefs(runId, repoName).branches}s${rest}`
}

/** Matches the session's own branches: `shuttle/<runId>/…` and `shuttle/<runId>-stack<n>/…`. */
function sessionBranchPattern(runId: string): string {
  return `^shuttle/${runId.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(-stack[0-9]*)?/`
}

function gitAuth(remote: SyncRemote): string {
  return `-c http.extraheader=${shellQuote(`Authorization: Basic ${remote.basicAuth}`)}`
}

async function run(host: SyncHost, script: string, cwd: string, what: string): Promise<string> {
  const result = await host.exec(script, { cwd, timeoutMs: SYNC_TIMEOUT_MS })

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not ${what}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    )
  }

  return result.stdout
}

/** Reads what the snapshot script printed: one `KIND rest-of-line` record per line. */
export function parseSnapshot(repoName: string, output: string): SessionSnapshot {
  const fields = { head: '', headSha: '', snapshotSha: '' }
  const branches: { name: string; sha: string }[] = []
  const config: { key: string; value: string }[] = []

  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    const kind = space < 0 ? line : line.slice(0, space)
    const rest = space < 0 ? '' : line.slice(space + 1)

    switch (kind) {
      case 'HEAD':
        fields.head = rest
        break
      case 'HEADSHA':
        fields.headSha = rest
        break
      case 'SNAPSHOT':
        fields.snapshotSha = rest
        break

      case 'BRANCH': {
        const [sha = '', name = ''] = rest.split(' ')

        if (sha && name) {
          branches.push({ name, sha })
        }

        break
      }

      case 'CONFIG': {
        const at = rest.indexOf(' ')

        if (at > 0) {
          config.push({ key: rest.slice(0, at), value: rest.slice(at + 1) })
        }

        break
      }

      default:
        break
    }
  }

  if (!fields.head || !fields.headSha || !fields.snapshotSha) {
    throw new Error(`Could not snapshot ${repoName}: the worktree reported no branch or commit`)
  }

  return { repoName, ...fields, branches, config }
}

/**
 * Pushes the session's branches and a snapshot of its working directory for `repoName` to
 * `remote`, and returns what was pushed.
 */
export async function snapshotSession(
  host: SyncHost,
  runId: string,
  repoName: string,
  remote: SyncRemote,
): Promise<SessionSnapshot> {
  const refs = sessionRemoteRefs(runId, repoName)

  const script = [
    'set -e',
    // A session always works on a branch; a detached HEAD has no branch to come back to.
    'head=$(git symbolic-ref --short HEAD)',
    'headSha=$(git rev-parse HEAD)',
    // Stage everything into a copy of the index, so the real index and branch are untouched.
    'index=$(mktemp)',
    'cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true',
    'GIT_INDEX_FILE="$index" git add -A',
    'tree=$(GIT_INDEX_FILE="$index" git write-tree)',
    'rm -f "$index"',
    'snapshot=$(git -c user.name=Shuttle -c user.email=shuttle@local commit-tree "$tree" -p "$headSha" -m "Shuttle snapshot")',
    `branches=$(git for-each-ref --format='%(refname:short)' refs/heads/shuttle/ | grep -E ${shellQuote(sessionBranchPattern(runId))} || true)`,
    `set -- "$snapshot:${refs.work}"`,
    // Branch names hold no spaces, so the list splits cleanly on whitespace.
    // The remote name drops the `shuttle/<runId>` the local one starts with: see `remoteBranchRef`.
    `for name in $branches; do set -- "$@" "refs/heads/$name:${refs.branches}s\${name#shuttle/${runId}}"; done`,
    `git ${gitAuth(remote)} push --quiet --force ${shellQuote(remote.url)} "$@"`,
    'echo "HEAD $head"',
    'echo "HEADSHA $headSha"',
    'echo "SNAPSHOT $snapshot"',
    'for name in $branches; do echo "BRANCH $(git rev-parse "refs/heads/$name") $name"; done',
    String.raw`git config --get-regexp '^branch\.shuttle/' | while read -r key value; do`,
    `  if printf '%s' "$key" | grep -qE ${shellQuote(sessionBranchPattern(runId).replace('^', String.raw`^branch\.`))}; then echo "CONFIG $key $value"; fi`,
    'done',
  ].join('\n')

  return parseSnapshot(
    repoName,
    await run(host, script, worktreeRepoPath(runId, repoName), `snapshot ${repoName}`),
  )
}

/**
 * Rebuilds the session's worktree for `snapshot.repoName` from `remote`. The repository must
 * already be cloned here. A worktree this sandbox still has from an earlier turn is replaced:
 * the snapshot is newer than anything left behind.
 */
export async function restoreSession(
  host: SyncHost,
  runId: string,
  remote: SyncRemote,
  snapshot: SessionSnapshot,
): Promise<void> {
  const refs = sessionRemoteRefs(runId, snapshot.repoName)
  const source = repoCheckoutPath(snapshot.repoName)
  const target = worktreeRepoPath(runId, snapshot.repoName)
  const local = `refs/shuttle/snapshots/${runId}/${snapshot.repoName}`

  const refspecs = [
    `+${refs.work}:${local}`,
    ...snapshot.branches.map(
      (branch) =>
        `+${remoteBranchRef(runId, snapshot.repoName, branch.name)}:refs/heads/${branch.name}`,
    ),
  ]

  const script = [
    'set -e',
    // A branch that is checked out cannot be fetched into, so the old worktree goes first.
    `if [ -e ${shellQuote(target)} ]; then`,
    `  git worktree remove --force ${shellQuote(target)} 2>/dev/null || rm -rf ${shellQuote(target)}`,
    '  git worktree prune',
    'fi',
    `git ${gitAuth(remote)} fetch --quiet --force ${shellQuote(remote.url)} ${refspecs.map(shellQuote).join(' ')}`,
    `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf('/')))}`,
    `git worktree add --quiet --force ${shellQuote(target)} ${shellQuote(snapshot.head)}`,
    // The working files become the snapshot's while HEAD and the index stay on the branch, so
    // what was uncommitted there is uncommitted here.
    `git -C ${shellQuote(target)} restore --source=${shellQuote(local)} --worktree --no-overlay -- .`,
    ...snapshot.config.map(
      ({ key, value }) =>
        `git -C ${shellQuote(target)} config ${shellQuote(key)} ${shellQuote(value)}`,
    ),
  ].join('\n')

  await run(host, script, source, `restore ${snapshot.repoName}`)
}
