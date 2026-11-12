import { z } from 'zod'

import { asEffectsTool, defineTool } from '@swirls/looms/agent'
import { gate } from '@swirls/looms/approval'
import { emit, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from '@swirls/looms/core'

import type { ShuttleEnv } from '../../env'
import { getPullRequest, listPullFiles, listReviewThreads } from '../../github/pulls'
import { readSandboxBinding } from '../../session/bind-sandbox'
import { shuttleModule } from '../../session/scope'

/** Lines covered by a unified diff patch (RIGHT side = new file). */
export function linesCoveredByPatch(patch: string | undefined): Set<number> {
  const lines = new Set<number>()

  if (!patch) {
    return lines
  }

  let newLine = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/)

      if (match?.[1]) {
        newLine = Number(match[1])
      }

      continue
    }

    if (line.startsWith('-')) {
      continue
    }

    if (line.startsWith('+') || line.startsWith(' ')) {
      lines.add(newLine)
      newLine += 1
    }
  }

  return lines
}

export function createReviewTools(env: ShuttleEnv, runId: string, storage?: DurableObjectStorage) {
  const coveredByPath = new Map<string, Set<number>>()
  let activePull: { fullName: string; number: number; headSha: string } | null = null

  const drafted: {
    path: string
    line: number
    side: 'LEFT' | 'RIGHT'
    body: string
    severity: string
    commentId: string
  }[] = []

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

      coveredByPath.clear()

      for (const file of files) {
        coveredByPath.set(file.path, linesCoveredByPatch(file.patch))
      }

      activePull = {
        fullName: summary.fullName,
        number: summary.number,
        headSha: summary.headSha,
      }

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
      const covered = coveredByPath.get(path)

      if (side === 'RIGHT' && covered && covered.size > 0 && !covered.has(line)) {
        throw new Error(
          `Line ${line} is outside the diff hunks for ${path}. Call pr_context and pick a covered line.`,
        )
      }

      const commentId = crypto.randomUUID()

      drafted.push({
        commentId,
        path,
        line,
        side,
        body,
        severity,
      })

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
              body: comment.body,
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
