import type { FolderSyncReport, PullInboxState, PullInboxSummary } from '@/lib/pulls'

function pull(
  partial: Partial<PullInboxSummary> & Pick<PullInboxSummary, 'fullName' | 'number' | 'title'>,
): PullInboxSummary {
  return {
    installationId: 1,
    body: '',
    url: `https://github.com/${partial.fullName}/pull/${partial.number}`,
    state: 'open',
    draft: false,
    author: { login: 'octocat', avatarUrl: '' },
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    baseSha: 'def456',
    additions: 42,
    deletions: 7,
    reviewDecision: 'review_required',
    checkRollup: 'pending',
    updatedAt: Date.now(),
    isFork: false,
    stack: null,
    linkedSessions: [],
    reviewingRunId: null,
    ...partial,
  }
}

/** Worst-case PR inbox for break-ui / fixture mode. */
export function worstCasePullInbox(now = Date.now()): PullInboxState {
  // A fixture workspace session, so linked PRs resolve a real title in fixture mode.
  const sessionA = 'fx-s1'
  const sessionB = 'run_review_live'

  return {
    policies: {
      'acme/api': {
        installationId: 1,
        folders: [{ folderId: 'fx-platform', autoReview: 'others' }],
      },
      'acme/web': {
        installationId: 1,
        folders: [{ folderId: 'fx-platform', autoReview: 'others' }],
      },
      'acme/infra': {
        installationId: 1,
        folders: [{ folderId: 'fx-platform', autoReview: 'all' }],
      },
    },
    pulls: Object.fromEntries(
      [
        pull({
          fullName: 'acme/api',
          number: 1201,
          title:
            'feat: add idempotent webhook delivery with outbox replay and poison-pill quarantine',
          additions: 1840,
          deletions: 220,
          reviewDecision: 'review_required',
          checkRollup: 'failing',
          updatedAt: now - 3 * 60_000,
          linkedSessions: [{ runId: sessionA, role: 'author', threadId: 'thr_conductor' }],
        }),
        pull({
          fullName: 'acme/web',
          number: 884,
          title: 'feat(inbox): keyboard-first PR triage with smart lanes',
          additions: 960,
          deletions: 40,
          reviewDecision: 'review_required',
          checkRollup: 'passing',
          updatedAt: now - 4 * 60_000,
          linkedSessions: [{ runId: sessionA, role: 'author', threadId: 'thr_conductor' }],
        }),
        pull({
          fullName: 'acme/infra',
          number: 55,
          title: 'chore: bump worker CPU for pulls run fan-in',
          draft: true,
          additions: 12,
          deletions: 3,
          reviewDecision: 'review_required',
          checkRollup: 'pending',
          updatedAt: now - 5 * 60_000,
          linkedSessions: [{ runId: sessionA, role: 'author', threadId: 'thr_conductor' }],
        }),
        pull({
          fullName: 'acme/api',
          number: 1198,
          title: 'fix: race when two syncRepo calls land on the same head SHA',
          additions: 38,
          deletions: 11,
          reviewDecision: 'changes_requested',
          checkRollup: 'passing',
          updatedAt: now - 2 * 60 * 60_000,
          author: { login: 'external-contributor-with-a-very-long-handle', avatarUrl: '' },
        }),
        pull({
          fullName: 'acme/web',
          number: 870,
          title: 'Review: harden diff anchors for deleted-file LEFT side comments',
          additions: 210,
          deletions: 90,
          reviewingRunId: sessionB,
          reviewDecision: 'review_required',
          checkRollup: 'pending',
          updatedAt: now - 90_000,
          linkedSessions: [{ runId: sessionB, role: 'reviewer', threadId: 'thr_reviewer' }],
        }),
        pull({
          fullName: 'acme/api',
          number: 1180,
          title: 'draft: experimental GraphQL search batching',
          draft: true,
          additions: 400,
          deletions: 0,
          reviewDecision: 'none',
          checkRollup: 'neutral',
          updatedAt: now - 24 * 60 * 60_000,
          linkedSessions: [{ runId: 'run_draft', role: 'author' }],
        }),
        pull({
          fullName: 'acme/infra',
          number: 40,
          title: 'Approved and green — ready to ship the pulls module',
          additions: 20,
          deletions: 5,
          reviewDecision: 'approved',
          checkRollup: 'passing',
          updatedAt: now - 10 * 60_000,
          linkedSessions: [{ runId: 'run_ship', role: 'author' }],
        }),
        pull({
          fullName: 'acme/web',
          number: 1,
          title: 'a',
          additions: 1,
          deletions: 0,
          author: { login: 'x', avatarUrl: '' },
          updatedAt: now - 7 * 24 * 60 * 60_000,
        }),
        // Native 3-layer stack split across drafts + needs_review.
        pull({
          fullName: 'acme/api',
          number: 1301,
          title: 'stack L1: schema for stacked publish',
          headRef: 'shuttle/fx-stack/api',
          baseRef: 'main',
          draft: true,
          stack: { number: 7, position: 1, size: 3 },
          additions: 80,
          deletions: 2,
          updatedAt: now - 20 * 60_000,
          linkedSessions: [{ runId: 'fx-stack', role: 'author', threadId: 'thr_conductor' }],
        }),
        pull({
          fullName: 'acme/api',
          number: 1302,
          title: 'stack L2: wire GitHub Stacks API',
          headRef: 'shuttle/fx-stack-stack/api/2',
          baseRef: 'shuttle/fx-stack/api',
          draft: true,
          stack: { number: 7, position: 2, size: 3 },
          additions: 120,
          deletions: 10,
          updatedAt: now - 18 * 60_000,
          linkedSessions: [{ runId: 'fx-stack', role: 'author', threadId: 'thr_conductor' }],
        }),
        pull({
          fullName: 'acme/api',
          number: 1303,
          title: 'stack L3: inbox ladder UI',
          headRef: 'shuttle/fx-stack-stack/api/3',
          baseRef: 'shuttle/fx-stack-stack/api/2',
          stack: { number: 7, position: 3, size: 3 },
          additions: 200,
          deletions: 15,
          reviewDecision: 'review_required',
          checkRollup: 'passing',
          updatedAt: now - 15 * 60_000,
          linkedSessions: [{ runId: 'fx-stack', role: 'author', threadId: 'thr_conductor' }],
        }),
        // Chained but non-native stack (baseRef→headRef only).
        pull({
          fullName: 'acme/infra',
          number: 90,
          title: 'chain bottom: metrics scrape path',
          headRef: 'feat/metrics-base',
          baseRef: 'main',
          additions: 60,
          deletions: 4,
          updatedAt: now - 40 * 60_000,
          linkedSessions: [{ runId: 'fx-chain', role: 'author' }],
        }),
        pull({
          fullName: 'acme/infra',
          number: 91,
          title: 'chain top: dashboard cards',
          headRef: 'feat/metrics-ui',
          baseRef: 'feat/metrics-base',
          additions: 90,
          deletions: 8,
          updatedAt: now - 35 * 60_000,
          linkedSessions: [{ runId: 'fx-chain', role: 'author' }],
        }),
      ].map((entry) => [`${entry.fullName}#${entry.number}`, entry]),
    ),
  }
}

/** One repo the GitHub App cannot read, plus withheld check status, for the access banner. */
export function worstCaseSyncReport(folderId: string): FolderSyncReport {
  return {
    folderId,
    upserted: 9,
    repos: [
      { fullName: 'acme/api', status: 'ok', open: 4, synced: 4, checksHidden: true, message: null },
      { fullName: 'acme/web', status: 'ok', open: 4, synced: 4, checksHidden: true, message: null },
      {
        fullName: 'acme/infra',
        status: 'ok',
        open: 2,
        synced: 2,
        checksHidden: true,
        message: null,
      },
      {
        fullName: 'acme/private-billing-service-with-a-long-name',
        status: 'forbidden',
        open: 0,
        synced: 0,
        checksHidden: false,
        message: 'The GitHub App cannot read pull requests in this repository.',
      },
    ],
    installations: [
      {
        installationId: 1,
        account: 'acme',
        missingPermissions: ['Pull requests', 'Checks', 'Commit statuses'],
        settingsUrl: 'https://github.com/organizations/acme/settings/installations/1',
      },
    ],
  }
}

export function emptyPullInboxFixture(): PullInboxState {
  return { pulls: {}, policies: {} }
}

export function hugePullInbox(now = Date.now()): PullInboxState {
  const pulls: Record<string, PullInboxSummary> = {}

  for (let index = 0; index < 120; index += 1) {
    const repo = ['acme/api', 'acme/web', 'acme/infra', 'acme/docs'][index % 4]!
    const number = 10_000 + index

    pulls[`${repo}#${number}`] = pull({
      fullName: repo,
      number,
      title: `Bulk fixture PR #${number} with a moderately long title for layout stress`,
      additions: (index * 17) % 500,
      deletions: (index * 3) % 80,
      reviewDecision:
        index % 5 === 0 ? 'changes_requested' : index % 3 === 0 ? 'approved' : 'review_required',
      checkRollup: index % 4 === 0 ? 'failing' : index % 2 === 0 ? 'passing' : 'pending',
      draft: index % 11 === 0,
      updatedAt: now - index * 60_000,
    })
  }

  return { pulls, policies: {} }
}
