/**
 * A pull request's diff, cut into the pieces the review tab draws: one patch per file, and for
 * each the lines a comment can sit on.
 */

export interface ReviewFile {
  readonly path: string
  /** The file's own patch, from its `diff --git` line to the next file's. */
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  /** New-file line numbers the patch shows: added and unchanged lines. */
  readonly rightLines: ReadonlySet<number>
  /** Old-file line numbers the patch shows: removed and unchanged lines. */
  readonly leftLines: ReadonlySet<number>
}

function pathOf(patch: string): string {
  const next = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1]
  const previous = patch.match(/^--- a\/(.+)$/m)?.[1]
  const header = patch.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1]

  return (next ?? previous ?? header ?? '').trim()
}

function fileOf(patch: string): ReviewFile {
  const rightLines = new Set<number>()
  const leftLines = new Set<number>()
  let additions = 0
  let deletions = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)

    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
    } else if (!inHunk) {
      continue
    } else if (line.startsWith('+')) {
      rightLines.add(newLine)
      newLine += 1
      additions += 1
    } else if (line.startsWith('-')) {
      leftLines.add(oldLine)
      oldLine += 1
      deletions += 1
    } else if (line.startsWith(' ')) {
      rightLines.add(newLine)
      leftLines.add(oldLine)
      oldLine += 1
      newLine += 1
    }
  }

  return { path: pathOf(patch), patch, additions, deletions, rightLines, leftLines }
}

/** The files of a `git diff`, in the order it lists them. */
export function reviewFiles(diff: string): ReviewFile[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((patch) => patch.startsWith('diff --git '))
    .map(fileOf)
    .filter((file) => file.path !== '')
}

/** Whether a comment on `line` of `side` has a line of the file's patch to sit on. */
export function anchorsIn(file: ReviewFile, side: 'LEFT' | 'RIGHT', line: number | null): boolean {
  return line !== null && (side === 'LEFT' ? file.leftLines : file.rightLines).has(line)
}
