import { hasText } from '../../lib/text'
export type DiffLineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta'

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
  /** 1-based line number on the new (RIGHT) side, when applicable. */
  readonly newLine?: number
  /** 1-based line number on the old (LEFT) side, when applicable. */
  readonly oldLine?: number
}

export interface DiffFile {
  readonly repo: string
  readonly path: string
  readonly lines: DiffLine[]
}

/** Parse a unified diff into per-file line rows with optional old/new line numbers. */
export function parseUnifiedDiff(diff: string, repo: string): DiffFile[] {
  if (diff.trim() === '') {
    return []
  }

  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let newLine = 0
  let oldLine = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = raw.match(/b\/(.+)$/)

      current = {
        repo,
        path: match?.[1] ?? 'unknown',
        lines: [],
      }

      files.push(current)
      newLine = 0
      oldLine = 0

      continue
    }

    if (!current) {
      current = { repo, path: 'patch', lines: [] }
      files.push(current)
    }

    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ')) {
      current.lines.push({ kind: 'meta', text: raw })
      continue
    }

    if (raw.startsWith('@@')) {
      const match = raw.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/)

      if (hasText(match?.[1]) && hasText(match[2])) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }

      current.lines.push({ kind: 'hunk', text: raw })
      continue
    }

    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw, newLine })
      newLine += 1
      continue
    }

    if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw, oldLine })
      oldLine += 1
      continue
    }

    current.lines.push({ kind: 'ctx', text: raw, newLine, oldLine })
    newLine += 1
    oldLine += 1
  }

  return files
}
