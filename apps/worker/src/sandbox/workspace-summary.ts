import { MAX_SESSION_COMMITS, parseComparison, type ParsedComparison } from '@shuttle/api'

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

export interface SummaryCommit {
  readonly sha: string
  readonly subject: string
  /** When it was committed, in milliseconds. */
  readonly at: number
  /** Local branches whose tip it is. */
  readonly branches: readonly string[]
}

/** How a repository's changes were measured. `error` is `missing` when a reference was not found. */
export interface SummaryMeasure {
  readonly baseSha: string | null
  readonly baseMode: 'merge-base' | 'tip' | null
  readonly headSha: string | null
  readonly error: 'missing' | null
}

export interface WorkspaceRepoSummary {
  /** The repository's directory in the worktree. */
  readonly name: string
  /** Every file, relative to the repository, leaving out what git ignores. */
  readonly files: readonly string[]
  readonly changes: readonly { readonly path: string; readonly status: ChangeStatus }[]
  /** Where the session started. Null when it could not be told. */
  readonly sessionBaseSha?: string | null
  /** The branch checked out, and its commit. */
  readonly head?: { readonly branch: string | null; readonly sha: string } | null
  /** Whether anything is not committed. */
  readonly dirty?: boolean
  /** The session's commits, newest first. */
  readonly commits?: readonly SummaryCommit[]
  readonly measure?: SummaryMeasure
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
  /** What its changes are measured against, as `Comparison` in `@shuttle/api` says. The session's start when left out. */
  readonly against?: string
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
 * Shell that sets `$found` to the commit `ref` names, or to nothing. A local branch comes first:
 * a stack layer's branch is newest there, and a branch fetched for a comparison is kept under
 * `origin/`.
 */
function resolveRefScript(ref: string): string {
  const quoted = (prefix: string) => shellQuote(`${prefix}${ref}^{commit}`)

  return [
    `found=$(git rev-parse --verify -q ${quoted('refs/heads/')} 2>/dev/null`,
    `  || git rev-parse --verify -q ${quoted('refs/remotes/origin/')} 2>/dev/null`,
    `  || git rev-parse --verify -q ${quoted('')} 2>/dev/null || true)`,
  ].join('')
}

/**
 * Shell that says what a repository's changes are measured against, as `comparison` asks. It sets
 * `$session_base` to where the session started, `$base` to the commit measured from, `$mode` to
 * how that was found, `$head` to the commit measured to (empty for the working tree), and `$err`
 * to `missing` when a reference is not in the sandbox, in which case `$base` is empty.
 */
export function comparisonScript(defaultBranch: string, comparison: ParsedComparison): string {
  const session = [
    baseCommitScript(defaultBranch),
    'session_base=$base; mode=merge-base; head=; err=',
  ]

  switch (comparison.kind) {
    case 'session':
      return session.join('\n')
    case 'uncommitted':
      return [...session, 'base=$(git rev-parse --verify -q HEAD 2>/dev/null || true)'].join('\n')
    case 'ref':
      return [
        ...session,
        resolveRefScript(comparison.ref),
        'if [ -z "$found" ]; then base=; mode=; err=missing',
        'elif base=$(git merge-base HEAD "$found" 2>/dev/null); then mode=merge-base',
        'else base=$found; mode=tip; fi',
      ].join('\n')
    case 'range':
      return [
        ...session,
        resolveRefScript(comparison.head),
        'head=$found',
        resolveRefScript(comparison.base),
        'if [ -z "$found" ] || [ -z "$head" ]; then base=; head=; mode=; err=missing',
        'elif base=$(git merge-base "$head" "$found" 2>/dev/null); then mode=merge-base',
        'else base=$found; mode=tip; fi',
      ].join('\n')
  }
}

/** The comparison a repository asks for, the session's start when it names none or a bad one. */
function comparisonOf(against: string | undefined): ParsedComparison {
  return (against && parseComparison(against)) || { kind: 'session' }
}

/**
 * Shell that runs `git diff` from `$base` to `$head`, or, when `$head` is empty, to the working
 * directory as it stands, new files included. `options` go before the commits and `pathspec`
 * after. For the working directory it stages everything into a copy of the index, so the real
 * index and the branch are untouched. Nothing runs when there is no `$base`.
 */
function measuredDiff(options: string, pathspec = ''): string {
  const tail = pathspec ? ` -- ${pathspec}` : ''

  return [
    'if [ -z "$base" ]; then :',
    `elif [ -n "$head" ]; then git diff --no-renames ${options} "$base" "$head"${tail}`,
    'else',
    'index=$(mktemp)',
    'cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true',
    `GIT_INDEX_FILE="$index" ${GIT_IGNORING} add -A 2>/dev/null`,
    `GIT_INDEX_FILE="$index" git diff --cached --no-renames ${options} "$base"${tail}`,
    'rm -f "$index"',
    'fi',
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
      comparisonScript(repo.defaultBranch, comparisonOf(repo.against)),
      `printf 'MEASURE\\t%s\\t%s\\t%s\\t%s\\n' "$session_base" "$base" "$mode" "$head"`,
      'if [ -n "$err" ]; then echo "ERROR $err"; fi',
      `printf 'HEAD\\t%s\\t%s\\n' "$(git symbolic-ref -q --short HEAD 2>/dev/null)" "$(git rev-parse --verify -q HEAD 2>/dev/null)"`,
      `if [ -n "$(${GIT_IGNORING} status --porcelain -uall 2>/dev/null | head -1)" ]; then echo DIRTY; fi`,
      // The session's commits, with the branches that end at each, for telling its layers apart.
      `if [ -n "$session_base" ]; then git log --max-count=${MAX_SESSION_COMMITS} --format='COMMIT%x09%H%x09%ct%x09%D%x09%s' "$session_base..HEAD" 2>/dev/null; fi`,
      // Files git tracks or would track, minus the ones deleted from the working directory.
      `{ ${GIT_IGNORING} ls-files -co --exclude-standard; git ls-files -d; } | sort | uniq -u | sed 's/^/FILE /'`,
      `{ ${measuredDiff('--name-status')}; } | sed 's/^/CHANGE /'`,
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

/** The local branches in `git log`'s `%D`: not `HEAD`, tags, or branches of a remote. */
function localBranches(decorations: string): string[] {
  return decorations
    .split(', ')
    .map((item) => item.replace(/^HEAD -> /, '').trim())
    .filter(
      (item) => item && item !== 'HEAD' && !item.startsWith('tag: ') && !item.startsWith('origin/'),
    )
}

type MutableRepo = {
  name: string
  files: string[]
  changes: { path: string; status: ChangeStatus }[]
  sessionBaseSha: string | null
  head: { branch: string | null; sha: string } | null
  dirty: boolean
  commits: SummaryCommit[]
  measure: { -readonly [K in keyof SummaryMeasure]: SummaryMeasure[K] }
}

/** Reads what `workspaceSummaryScript` printed: one `KIND rest-of-line` record per line. */
export function parseWorkspaceSummary(output: string): WorkspaceSummary {
  const repos: MutableRepo[] = []
  const strays: { path: string; files: number }[] = []

  for (const line of output.split('\n')) {
    // A record's kind ends at a space or, for those with fields, a tab.
    const space = line.search(/[ \t]/)
    const kind = space < 0 ? line : line.slice(0, space)
    const rest = space < 0 ? '' : line.slice(space + 1)
    const repo = repos.at(-1)

    if (kind === 'REPO' && rest) {
      repos.push({
        name: rest,
        files: [],
        changes: [],
        sessionBaseSha: null,
        head: null,
        dirty: false,
        commits: [],
        measure: { baseSha: null, baseMode: null, headSha: null, error: null },
      })
    } else if (kind === 'FILE' && rest && repo) {
      repo.files.push(rest)
    } else if (kind === 'CHANGE' && repo) {
      // `git diff --name-status` separates the status from the path with a tab.
      const [code = '', path = ''] = rest.split('\t')

      if (path) {
        repo.changes.push({ path, status: changeStatus(code) })
      }
    } else if (kind === 'MEASURE' && repo) {
      const [session = '', base = '', mode = '', head = ''] = rest.split('\t')

      repo.sessionBaseSha = session || null
      repo.measure.baseSha = base || null
      repo.measure.baseMode = mode === 'merge-base' || mode === 'tip' ? mode : null
      repo.measure.headSha = head || null
    } else if (kind === 'ERROR' && repo) {
      repo.measure.error = rest === 'missing' ? 'missing' : null
    } else if (kind === 'HEAD' && repo) {
      const [branch = '', sha = ''] = rest.split('\t')

      repo.head = sha ? { branch: branch || null, sha } : null
    } else if (kind === 'DIRTY' && repo) {
      repo.dirty = true
    } else if (kind === 'COMMIT' && repo) {
      const [sha = '', time = '', decorations = '', ...subject] = rest.split('\t')

      if (sha) {
        repo.commits.push({
          sha,
          subject: subject.join('\t'),
          at: Number(time) * 1000 || 0,
          branches: localBranches(decorations),
        })
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

/** The script that prints one file's changes, from where `against` measures, as a unified diff. */
export function fileDiffScript(defaultBranch: string, path: string, against?: string): string {
  return [
    IGNORE_SETUP,
    comparisonScript(defaultBranch, comparisonOf(against)),
    measuredDiff('', shellQuote(path)),
    'rm -f "$ignore"',
  ].join('\n')
}

/** The script that prints everything a repository has changed since the session started. */
export function repoDiffScript(defaultBranch: string): string {
  return [
    IGNORE_SETUP,
    comparisonScript(defaultBranch, { kind: 'session' }),
    measuredDiff(''),
    'rm -f "$ignore"',
  ].join('\n')
}

/**
 * The script that prints one file as it was where `against` measures from or, as `head`, at the
 * commit it measures to. It exits non-zero when the file did not exist there, or when `head` is
 * asked for and the comparison measures to the working tree.
 */
export function baseFileScript(
  defaultBranch: string,
  path: string,
  against?: string,
  version: 'base' | 'head' = 'base',
): string {
  const commit = version === 'head' ? '$head' : '$base'

  return [
    comparisonScript(defaultBranch, comparisonOf(against)),
    `if [ -z "${commit}" ]; then exit 1; fi`,
    `git show "${commit}":${shellQuote(path)}`,
  ].join('\n')
}

/**
 * The script that lists the branches a repository can be compared with: GitHub's, read with
 * `auth` (a git `-c` option carrying the credential), and the local ones, as `REMOTE <name>` and
 * `LOCAL <name>` lines. GitHub's are left out when it cannot be reached.
 */
export function branchesScript(auth: string): string {
  return [
    `git ${auth} ls-remote --heads origin 2>/dev/null | sed -n 's#^[0-9a-f]*\trefs/heads/#REMOTE #p'`,
    `git for-each-ref --format='LOCAL %(refname:short)' refs/heads/ 2>/dev/null`,
  ].join('\n')
}

/**
 * The script that fetches one branch from GitHub into `origin/<branch>`, unless the sandbox has it
 * already, so changes can be compared with it. History is fetched far enough back that where the
 * two split is usually found.
 */
export function fetchBranchScript(auth: string, branch: string): string {
  const remote = shellQuote(`refs/remotes/origin/${branch}`)

  return [
    `if git rev-parse --verify -q ${shellQuote(`refs/heads/${branch}^{commit}`)} >/dev/null || git rev-parse --verify -q ${remote} >/dev/null; then exit 0; fi`,
    `git ${auth} fetch --quiet --no-tags --depth 200 origin ${shellQuote(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`,
  ].join('\n')
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
