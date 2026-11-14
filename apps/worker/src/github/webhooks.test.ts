import { describe, expect, test } from 'bun:test'

import { fakeEnv } from '../testing/fake-env'
import { normalizeWebhook, verifyWebhookSignature } from './webhooks'

describe('github webhooks', () => {
  test('verifies hmac sha256 signatures', async () => {
    const env = fakeEnv({
      GITHUB_WEBHOOK_SECRET: 'whsec_test',
    })

    const rawBody = '{"action":"opened"}'

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('whsec_test'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )

    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))

    const hex = [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')

    expect(await verifyWebhookSignature(env, rawBody, `sha256=${hex}`)).toBe(true)
    expect(await verifyWebhookSignature(env, rawBody, `sha256=${hex}ff`)).toBe(false)
    expect(await verifyWebhookSignature(env, rawBody, null)).toBe(false)
  })

  test('normalizes pull_request opened', () => {
    const result = normalizeWebhook('pull_request', 'del-1', {
      action: 'opened',
      installation: { id: 42 },
      repository: { full_name: 'acme/api' },
      pull_request: {
        number: 7,
        title: 'Add feature',
        body: 'Details',
        html_url: 'https://github.com/acme/api/pull/7',
        draft: true,
        updated_at: '2026-01-01T00:00:00Z',
        additions: 10,
        deletions: 2,
        user: { login: 'dylan', avatar_url: 'https://example.com/a.png' },
        head: { ref: 'shuttle/run/api', sha: 'abc', repo: { fork: false } },
        base: { ref: 'main', sha: 'def' },
      },
    })

    expect(result.kind).toBe('pull.upserted')

    if (result.kind === 'pull.upserted') {
      expect(result.fullName).toBe('acme/api')
      expect(result.number).toBe(7)
      expect(result.action).toBe('opened')
      expect(result.draft).toBe(true)
      expect(result.installationId).toBe(42)
    }
  })

  test('normalizes pull_request closed', () => {
    const result = normalizeWebhook('pull_request', 'del-2', {
      action: 'closed',
      installation: { id: 1 },
      repository: { full_name: 'acme/api' },
      pull_request: { number: 3, updated_at: '2026-01-02T00:00:00Z' },
    })

    expect(result).toEqual({
      kind: 'pull.closed',
      deliveryId: 'del-2',
      installationId: 1,
      fullName: 'acme/api',
      number: 3,
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
    })
  })

  test('normalizes review submitted', () => {
    const result = normalizeWebhook('pull_request_review', 'del-3', {
      action: 'submitted',
      installation: { id: 9 },
      repository: { full_name: 'acme/web' },
      pull_request: { number: 11 },
      review: { state: 'changes_requested', submitted_at: '2026-01-03T00:00:00Z' },
    })

    expect(result.kind).toBe('review.submitted')

    if (result.kind === 'review.submitted') {
      expect(result.verdict).toBe('changes_requested')
    }
  })

  test('ignores unknown events', () => {
    const result = normalizeWebhook('issues', 'del-4', { action: 'opened' })
    expect(result.kind).toBe('ignored')
  })
})

describe('review comment webhooks', () => {
  const base = {
    installation: { id: 7 },
    repository: { full_name: 'acme/glue' },
    pull_request: { number: 8, updated_at: '2026-11-14T10:00:00Z' },
  }

  const comment = {
    id: 501,
    in_reply_to_id: 500,
    path: 'app.js',
    line: null,
    original_line: 40,
    side: 'RIGHT',
    body: 'Agreed.',
    user: { login: 'dylan', avatar_url: 'https://example.com/a.png' },
    created_at: '2026-11-14T10:00:00Z',
    updated_at: '2026-11-14T10:01:00Z',
    html_url: 'https://github.com/acme/glue/pull/8#discussion_r501',
  }

  test('a reply is filed under the comment it answers, keeping where an outdated one sat', () => {
    const result = normalizeWebhook('pull_request_review_comment', 'del-c1', {
      ...base,
      action: 'created',
      comment,
    })

    expect(result).toMatchObject({
      kind: 'comment.upserted',
      installationId: 7,
      fullName: 'acme/glue',
      number: 8,
      comment: { commentId: 501, rootId: 500, line: 40, outdated: true, body: 'Agreed.' },
    })
  })

  test('a comment that starts a thread is its own root, and a deletion names the comment', () => {
    const started = normalizeWebhook('pull_request_review_comment', 'del-c2', {
      ...base,
      action: 'edited',
      comment: { ...comment, id: 500, in_reply_to_id: undefined, line: 12 },
    })

    expect(started).toMatchObject({
      kind: 'comment.upserted',
      comment: { commentId: 500, rootId: 500, line: 12, outdated: false },
    })

    expect(
      normalizeWebhook('pull_request_review_comment', 'del-c3', {
        ...base,
        action: 'deleted',
        comment,
      }),
    ).toMatchObject({ kind: 'comment.removed', commentId: 501 })
  })

  test('resolving a thread names it by its first comment', () => {
    const result = normalizeWebhook('pull_request_review_thread', 'del-t1', {
      ...base,
      action: 'resolved',
      thread: { comments: [{ id: 500 }, { id: 501 }] },
    })

    expect(result).toMatchObject({ kind: 'thread.resolution', rootId: 500, resolved: true })
  })
})

describe('review comments about several lines', () => {
  test('keep where the lines start as well as where they end', () => {
    const result = normalizeWebhook('pull_request_review_comment', 'del-c4', {
      installation: { id: 7 },
      repository: { full_name: 'acme/glue' },
      pull_request: { number: 8 },
      action: 'created',
      comment: { id: 600, path: 'app.js', start_line: 5, line: 8, side: 'RIGHT', body: 'These.' },
    })

    expect(result).toMatchObject({
      kind: 'comment.upserted',
      comment: { commentId: 600, startLine: 5, line: 8 },
    })
  })
})
