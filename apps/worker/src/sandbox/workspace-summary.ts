import { shellQuote } from './exec-argv'
import { REVIEW_BASE_CONFIG_KEY } from './stack'
import { worktreeRepoPath, worktreeRoot } from './workspace'

/**
 * What a session's workspace holds right now, read from the sandbox it is in: each repository's
 * files, and which of them the session has added, changed or deleted since it branched off.
 *
 * "Changed" is measured against the commit the session started from, and counts work that is
 * committed on the session's branches as well as work that is not, including new files git has
 * not been told about. That is the question people in a session ask: what has been done here.
 */

/** How a file differs from where the session started: added, modified or deleted. */
export type ChangeStatus = 'A' | 'M' | 'D'

export interface WorkspaceRepoSummary {
  /** The repository's directory in the worktree. */
  readonly name: string
  /** Every file, relative to the repository, leaving out what git ignores. */
  readonly files: readonly string[]
  readonly changes: readonly { readonly path: string; readonly status: ChangeStatus }[]
}

export interface WorkspaceSummary {
  readonly repos: readonly WorkspaceRepoSummary[]
  /** Things written under /workspace but outside the worktree since the session began. */
  readonly strays: readonly { readonly path: string; readonly files: number }[]
}

/** A repository the summary should describe, with the branch its changes are measured from. */
export interface SummaryRepo {
  readonly name: string
  readonly defaultBranch: string
}

/**
 * Untracked things that are never the session's work, whatever the repository's own ignore file
 * says: installed dependencies and caches. A scratch repository has no ignore file at all, and
 * without this an `npm install` shows up as thousands of new files and is uploaded with every save.
 * Files a repository already tracks are unaffected.
 */
const NEVER_WORK = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.cache/',
  '.next/',
  '.turbo/',
  '.DS_Store',
]

/** Whether `path` is one of those, for copies saved before saves left them out. */
export function isNeverWork(path: string): boolean {
  const names = new Set(NEVER_WORK.map((pattern) => pattern.replace(/\/$/, '')))

  return path.split('/').some((part) => names.has(part))
}

/** Shell that writes those patterns to a file and names it in `$ignore`. Run it once per script. */
export const IGNORE_SETUP = `ignore=$(mktemp); printf '%s\\n' ${NEVER_WORK.map(shellQuote).join(' ')} > "$ignore"`

/** `git`, told to ignore what `IGNORE_SETUP` listed as well as what the repository ignores. */
export const GIT_IGNORING = 'git -c core.excludesFile="$ignore"'

/**
 * Shell that sets `$base` to the commit the session's work in the current repository started
 * from: where its branch left `defaultBranch`, or the oldest commit it has when the two share
 * no history here (a shallow clone whose default branch has since moved on). A review session
 * did not branch off anything: its work is a pull request, measured from that pull request's base.
 */
export function baseCommitScript(defaultBranch: string): string {
  const branch = shellQuote(defaultBranch)

  return [
    `base=$(review=$(git config --get "branch.$(git rev-parse --abbrev-ref HEAD 2>/dev/null).${REVIEW_BASE_CONFIG_KEY}" 2>/dev/null)`,
    `  && git rev-parse --verify -q "$review^{commit}" 2>/dev/null`,
    `  || git merge-base HEAD refs/remotes/origin/${branch} 2>/dev/null`,
    `  || git merge-base HEAD refs/heads/${branch} 2>/dev/null`,
    `  || git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)`,
  ].join('')
}

/**
 * Shell that runs `git diff` between `$base` and the working directory as it stands, new files
 * included, with `args` appended. It stages everything into a copy of the index, so the real
 * index and the branch are untouched.
 */
function diffFromBase(args: string): string {
  return [
    'index=$(mktemp)',
    'cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true',
    `GIT_INDEX_FILE="$index" ${GIT_IGNORING} add -A 2>/dev/null`,
    `GIT_INDEX_FILE="$index" git diff --cached --no-renames ${args}`,
    'rm -f "$index"',
  ].join('\n')
}

/** Directories under /workspace that are Shuttle's own, not work an agent left there. */
const RESERVED = ['repos']

/** The script whose output `parseWorkspaceSummary` reads. */
export function workspaceSummaryScript(runId: string, repos: readonly SummaryRepo[]): string {
  const root = worktreeRoot(runId)
  const first = repos[0]

  return [
    IGNORE_SETUP,
    ...repos.flatMap((repo) => [
      `if cd ${shellQuote(worktreeRepoPath(runId, repo.name))} 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then`,
      `echo ${shellQuote(`REPO ${repo.name}`)}`,
      baseCommitScript(repo.defaultBranch),
      // Files git tracks or would track, minus the ones deleted from the working directory.
      `{ ${GIT_IGNORING} ls-files -co --exclude-standard; git ls-files -d; } | sort | uniq -u | sed 's/^/FILE /'`,
      diffFromBase(`--name-status "$base" | sed 's/^/CHANGE /'`),
      'fi',
    ]),
    // Anything that appeared beside the worktree after the session's own files did.
    ...(first
      ? [
          `marker=${shellQuote(`${worktreeRepoPath(runId, first.name)}/.git`)}`,
          `if [ -e "$marker" ]; then`,
          `find /workspace -mindepth 1 -maxdepth 1 ! -name '.*' ${RESERVED.map((name) => `! -name ${shellQuote(name)}`).join(' ')} -newer "$marker" 2>/dev/null | while read -r stray; do`,
          `  echo "STRAY $(find "$stray" -type f 2>/dev/null | head -500 | wc -l | tr -d ' ') $stray"`,
          'done',
          'fi',
        ]
      : []),
    'rm -f "$ignore"',
    `cd ${shellQuote(root)} 2>/dev/null || true`,
  ].join('\n')
}

function changeStatus(code: string): ChangeStatus {
  return code.startsWith('A') ? 'A' : code.startsWith('D') ? 'D' : 'M'
}

/** Reads what `workspaceSummaryScript` printed: one `KIND rest-of-line` record per line. */
export function parseWorkspaceSummary(output: string): WorkspaceSummary {
  const repos: {
    name: string
    files: string[]
    changes: { path: string; status: ChangeStatus }[]
  }[] = []

  const strays: { path: string; files: number }[] = []

  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    const kind = space < 0 ? line : line.slice(0, space)
    const rest = space < 0 ? '' : line.slice(space + 1)
    const repo = repos.at(-1)

    if (kind === 'REPO' && rest) {
      repos.push({ name: rest, files: [], changes: [] })
    } else if (kind === 'FILE' && rest && repo) {
      repo.files.push(rest)
    } else if (kind === 'CHANGE' && repo) {
      // `git diff --name-status` separates the status from the path with a tab.
      const [code = '', path = ''] = rest.split('\t')

      if (path) {
        repo.changes.push({ path, status: changeStatus(code) })
      }
    } else if (kind === 'STRAY') {
      const at = rest.indexOf(' ')
      const files = Number(rest.slice(0, at))

      if (at > 0 && Number.isFinite(files)) {
        strays.push({ path: rest.slice(at + 1), files })
      }
    }
  }

  return { repos, strays }
}

/** The script that prints one file's changes since the session started, as a unified diff. */
export function fileDiffScript(defaultBranch: string, path: string): string {
  return [
    IGNORE_SETUP,
    baseCommitScript(defaultBranch),
    diffFromBase(`"$base" -- ${shellQuote(path)}`),
    'rm -f "$ignore"',
  ].join('\n')
}

/** The script that prints everything a repository has changed since the session started. */
export function repoDiffScript(defaultBranch: string): string {
  return [
    IGNORE_SETUP,
    baseCommitScript(defaultBranch),
    diffFromBase('"$base"'),
    'rm -f "$ignore"',
  ].join('\n')
}

/**
 * The script that prints one file as it was when the session started. It exits non-zero when
 * the file did not exist then.
 */
export function baseFileScript(defaultBranch: string, path: string): string {
  return [baseCommitScript(defaultBranch), `git show "$base":${shellQuote(path)}`].join('\n')
}

/**
 * The script that moves something an agent left under /workspace into a repository's worktree.
 * It refuses rather than overwrite anything.
 */
export function adoptStrayScript(stray: string, into: string): string {
  const name = stray.slice(stray.lastIndexOf('/') + 1)
  const target = `${into}/${name}`

  return [
    `if [ -e ${shellQuote(target)} ]; then echo ${shellQuote(`${name} already exists in the workspace`)} >&2; exit 1; fi`,
    `if [ ! -e ${shellQuote(stray)} ]; then echo ${shellQuote(`${stray} is no longer there`)} >&2; exit 1; fi`,
    `mv ${shellQuote(stray)} ${shellQuote(target)}`,
  ].join('\n')
}

/** Whether `path` is something `adoptStrayScript` may move: directly under /workspace, and not Shuttle's. */
export function isAdoptable(path: string): boolean {
  const match = /^\/workspace\/([^/]+)$/.exec(path)
  const name = match?.[1] ?? ''

  return Boolean(name) && !name.startsWith('.') && !RESERVED.includes(name)
}
