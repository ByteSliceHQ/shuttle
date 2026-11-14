import { z } from 'zod'

import { asEffectsTool, defineTool } from '@swirls/looms/agent'
import { gate } from '@swirls/looms/approval'
import { emit, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from '@swirls/looms/core'

import type { ShuttleEnv } from '../../env'
import { getPullRequest, listPullFiles, listReviewThreads } from '../../github/pulls'
import { readSandboxBinding } from '../../session/bind-sandbox'
import { shuttleModule } from '../../session/scope'

/**
 * Lines a comment can be anchored to in a unified diff patch: on the RIGHT, lines of the new
 * file (added or context); on the LEFT, lines of the old file (removed or context).
 */
export function linesCoveredByPatch(
  patch: string | undefined,
  side: 'LEFT' | 'RIGHT' = 'RIGHT',
): Set<number> {
  const lines = new Set<number>()

  if (!patch) {
    return lines
  }

  let oldLine = 0
  let newLine = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/)

      if (match?.[1] && match[2]) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }

      continue
    }

    if (line.startsWith('-')) {
      if (side === 'LEFT') {
        lines.add(oldLine)
      }

      oldLine += 1
    } else if (line.startsWith('+')) {
      if (side === 'RIGHT') {
        lines.add(newLine)
      }

      newLine += 1
    } else if (line.startsWith(' ')) {
      lines.add(side === 'LEFT' ? oldLine : newLine)
      oldLine += 1
      newLine += 1
    }
  }

  return lines
}

export interface AnchoredComment {
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
  readonly body: string
}

/**
 * Splits `comments` into those GitHub will accept on the lines they name and those it will not:
 * a file the pull request does not touch, a file with no patch, or a line outside its hunks.
 * One comment GitHub cannot place makes it refuse the whole review, so those go in the body.
 */
export function partitionByAnchor<T extends AnchoredComment>(
  comments: readonly T[],
  files: readonly { readonly path: string; readonly patch?: string }[],
): { anchored: T[]; unanchored: T[] } {
  const patches = new Map(files.map((file) => [file.path, file.patch]))
  const anchored: T[] = []
  const unanchored: T[] = []

  for (const comment of comments) {
    const covered = linesCoveredByPatch(patches.get(comment.path), comment.side)

    if (covered.has(comment.line)) {
      anchored.push(comment)
    } else {
      unanchored.push(comment)
    }
  }

  return { anchored, unanchored }
}

/** The review body, followed by the comments that could not be placed on a line. */
export function bodyWithUnanchored(body: string, unanchored: readonly AnchoredComment[]): string {
  if (unanchored.length === 0) {
    return body
  }

  return [
    body,
    '',
    '**Comments on lines outside the diff**',
    '',
    ...unanchored.map((comment) => `- \`${comment.path}:${comment.line}\` ${comment.body}`),
  ].join('\n')
}

/** A comment's text as GitHub shows it, with a proposed replacement as a suggestion block. */
export function commentBody(body: string, suggestion: string | undefined): string {
  return suggestion ? `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\`` : body
}

/** What the reviewer has drafted so far, kept so it survives the session's process restarting. */
export const REVIEW_DRAFT_KEY = 'shuttle:review-draft'

interface ReviewDraftState {
  readonly activePull: { fullName: string; number: number; headSha: string } | null
  readonly drafted: readonly DraftedComment[]
}

interface DraftedComment {
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
  readonly body: string
  readonly severity: string
  readonly commentId: string
  readonly suggestion?: string
}

export function createReviewTools(env: ShuttleEnv, runId: string, storage?: DurableObjectStorage) {
  const patchByPath = new Map<string, string | undefined>()
  let activePull: ReviewDraftState['activePull'] = null
  const drafted: DraftedComment[] = []

  // Tool effects cannot wait, so the saved draft is read as soon as the tools exist and
  // written after each change. Anything drafted before it loads is kept.
  void storage?.get<ReviewDraftState>(REVIEW_DRAFT_KEY).then((saved) => {
    if (!saved) {
      return
    }

    activePull ??= saved.activePull

    const known = new Set(drafted.map((comment) => comment.commentId))

    drafted.unshift(...saved.drafted.filter((comment) => !known.has(comment.commentId)))
  })

  const save = () => {
    void storage?.put(REVIEW_DRAFT_KEY, {
      activePull,
      drafted: [...drafted],
    } satisfies ReviewDraftState)
  }

  async function resolveRepo(fullName: string) {
    const binding = await readSandboxBinding(storage, runId)
    return binding?.repos.find((repo) => repo.fullName === fullName) ?? null
  }

  const prContext = defineTool({
    name: 'pr_context',
    description: 'Load pull request body, changed files, review threads, and metadata',
    input: z.object({
      fullName: z.string(),
      number: z.number().int().positive(),
    }),
    handler: async (input): Promise<JsonValue> => {
      const repo = await resolveRepo(input.fullName)

      if (!repo) {
        return { ok: false, error: `Repository ${input.fullName} is not linked in this session` }
      }

      const [summary, files, threads] = await Promise.all([
        getPullRequest(env, repo, input.number),
        listPullFiles(env, repo, input.number),
        listReviewThreads(env, repo, input.number),
      ])

      patchByPath.clear()

      for (const file of files) {
        patchByPath.set(file.path, file.patch)
      }

      activePull = {
        fullName: summary.fullName,
        number: summary.number,
        headSha: summary.headSha,
      }

      save()

      return {
        ok: true,
        title: summary.title,
        body: summary.body,
        draft: summary.draft,
        headSha: summary.headSha,
        baseSha: summary.baseSha,
        files: files.map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
        threads: threads.map((thread) => ({
          id: thread.id,
          path: thread.path,
          line: thread.line,
          isResolved: thread.isResolved,
          comments: thread.comments,
        })),
      }
    },
  })

  const draftReviewComment = asEffectsTool({
    name: 'draft_review_comment',
    description: 'Draft an inline review comment anchored to a diff line',
    input: z.object({
      path: z.string(),
      line: z.number().int().positive(),
      side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
      severity: z.enum(['info', 'warning', 'error']).default('info'),
      body: z.string(),
      suggestion: z.string().optional(),
    }),
    effects: (input) => {
      const obj = isJsonObject(input) ? input : {}
      const path = isJsonString(obj.path) ? obj.path : ''
      const line = isJsonNumber(obj.line) ? obj.line : 0
      const side = obj.side === 'LEFT' ? ('LEFT' as const) : ('RIGHT' as const)

      const severity =
        obj.severity === 'warning' || obj.severity === 'error' ? obj.severity : ('info' as const)

      const body = isJsonString(obj.body) ? obj.body : ''
      const suggestion = isJsonString(obj.suggestion) ? obj.suggestion : undefined

      // Checked when the diff is at hand; the review is checked again before it is sent.
      if (patchByPath.size > 0) {
        if (!patchByPath.has(path)) {
          throw new Error(
            `${path} is not changed by this pull request. Comment on a file from pr_context.`,
          )
        }

        const covered = linesCoveredByPatch(patchByPath.get(path), side)

        if (covered.size > 0 && !covered.has(line)) {
          throw new Error(
            `Line ${line} (${side}) is outside the diff hunks for ${path}. Pick a line the diff shows.`,
          )
        }
      }

      const commentId = crypto.randomUUID()

      drafted.push({
        commentId,
        path,
        line,
        side,
        body,
        severity,
        ...(suggestion ? { suggestion } : {}),
      })

      save()

      return [
        emit(
          shuttleModule.input('review.comment.drafted', {
            commentId,
            path,
            line,
            side,
            severity,
            body,
            ...(suggestion ? { suggestion } : {}),
          }),
          `draft_comment_${commentId}`,
        ),
      ]
    },
  })

  const submitReview = asEffectsTool({
    name: 'submit_review',
    description: 'Propose submitting the drafted review; the user must approve first',
    input: z.object({
      summary: z.string(),
      verdict: z.enum(['approve', 'request_changes', 'comment']),
      comments: z
        .array(
          z.object({
            path: z.string(),
            line: z.number(),
            side: z.enum(['LEFT', 'RIGHT']),
            body: z.string(),
          }),
        )
        .optional(),
    }),
    effects: (input) => {
      const obj = isJsonObject(input) ? input : {}
      const summary = isJsonString(obj.summary) ? obj.summary : 'Shuttle review'
      const verdict = isJsonString(obj.verdict) ? obj.verdict : 'comment'
      const approvalId = `pr_review_${crypto.randomUUID()}`

      const comments =
        Array.isArray(obj.comments) && obj.comments.length > 0
          ? obj.comments
          : drafted.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: commentBody(comment.body, comment.suggestion),
            }))

      const fullName = activePull?.fullName ?? ''
      const number = activePull?.number ?? 0
      const commitId = activePull?.headSha ?? ''

      return gate({
        approvalId,
        title: 'Submit pull request review?',
        description: summary,
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', default: summary },
            verdict: {
              type: 'string',
              enum: ['approve', 'request_changes', 'comment'],
              default: verdict,
            },
            comments: { type: 'array', default: comments },
            fullName: { type: 'string', default: fullName },
            number: { type: 'number', default: number },
            commitId: { type: 'string', default: commitId },
          },
        },
        actions: [
          { id: 'submit', label: 'Submit review', outcome: 'approve' },
          { id: 'discard', label: 'Discard', outcome: 'reject' },
        ],
      })
    },
    waitOn: { type: 'approval.decided' },
  })

  return { prContext, draftReviewComment, submitReview }
}
