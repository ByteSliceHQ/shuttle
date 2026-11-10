import type {
  GithubInstallation,
  LinkedRepo,
  WorkspaceFolder,
  WorkspaceSession,
  WorkspaceTree,
} from '@/lib/workspace'

export const FIXTURE_MODES = ['live', 'worst', 'empty', 'huge'] as const
export type FixtureMode = (typeof FIXTURE_MODES)[number]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function repo(owner: string, name: string, extra?: Partial<LinkedRepo>): LinkedRepo {
  return {
    installationId: 1,
    owner,
    name,
    fullName: `${owner}/${name}`,
    defaultBranch: 'main',
    private: false,
    ...extra,
  }
}

function folder(
  folderId: string,
  name: string,
  repos: LinkedRepo[],
  extra?: Partial<WorkspaceFolder>,
): WorkspaceFolder {
  return { folderId, name, createdAt: 0, archived: false, repos, ...extra }
}

function session(
  runId: string,
  folderId: string,
  title: string,
  updatedAt: number,
  extra?: Partial<WorkspaceSession>,
): WorkspaceSession {
  return {
    runId,
    folderId,
    title,
    goal: title,
    status: 'running',
    activity: 'idle',
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    ...extra,
  }
}

function tree(
  folders: WorkspaceFolder[],
  sessions: WorkspaceSession[],
  installations: GithubInstallation[],
): WorkspaceTree {
  return {
    folderOrder: folders.map((entry) => entry.folderId),
    folders: Object.fromEntries(folders.map((entry) => [entry.folderId, entry])),
    sessions: Object.fromEntries(sessions.map((entry) => [entry.runId, entry])),
    installations: Object.fromEntries(
      installations.map((entry) => [String(entry.installationId), entry]),
    ),
  }
}

const NORTHWIND = 'northwind-industries-holdings'

/** Realistic worst-case values spread across rows, the way production data mixes them. */
function worstCase(now: number): WorkspaceTree {
  const platform = folder(
    'fx-platform',
    'Northwind Platform Infrastructure & Developer Experience',
    [
      repo(NORTHWIND, 'customer-feedback-from-enterprise-onboarding', { private: true }),
      repo(NORTHWIND, 'api', { defaultBranch: 'release/2026-11-hotfix-payments' }),
      repo('jo', 'x'),
      repo(NORTHWIND, 'web'),
      repo(NORTHWIND, 'mobile'),
      repo(NORTHWIND, 'infra-terraform-modules-shared', { private: true }),
      repo(NORTHWIND, 'docs'),
      repo(NORTHWIND, 'design-tokens'),
      repo(NORTHWIND, 'billing'),
      repo(NORTHWIND, 'search-indexer'),
      repo(NORTHWIND, 'auth'),
      repo(NORTHWIND, 'analytics-pipeline'),
    ],
  )

  const folders = [
    platform,
    folder('fx-jo', 'Jo', [repo('jo', 'dotfiles')]),
    folder('fx-german', 'Benachrichtigungseinstellungen', []),
    folder('fx-cjk', '王秀英的项目', [repo('wang', 'xiu-ying')]),
    folder('fx-rtl', 'نور الهدى عبد الرحمن', []),
    folder('fx-emoji', '👩🏽‍💻 Priya’s experiments', []),
    folder('fx-archived', 'Q3 launch (do not use)', [], { archived: true }),
  ]

  const sessions = [
    session(
      'fx-s1',
      platform.folderId,
      'Migrate the billing webhooks from the legacy Stripe v2 handler to the new idempotent queue consumer and backfill failed events',
      now - 20_000,
      { activity: 'working' },
    ),
    session('fx-s2', platform.folderId, 'Fix', now - 3 * MINUTE, { activity: 'needs_input' }),
    session(
      'fx-s3',
      platform.folderId,
      'Bump @northwind/design-tokens to 4.0.0-beta.12 across every package',
      now - 5 * HOUR,
      { status: 'failed' },
    ),
    session(
      'fx-s4',
      platform.folderId,
      '<script>alert(1)</script> &amp; **bold**',
      now - 12 * DAY,
      {
        status: 'completed',
      },
    ),
    session('fx-s5', platform.folderId, 'Line one\nLine two', now - 330 * DAY, {
      status: 'cancelled',
    }),
    session('fx-s6', platform.folderId, 'Untitled', now - 3 * 365 * DAY),
    session('fx-s7', platform.folderId, 'Rename getUserById to findUser', now - 40 * DAY, {
      status: 'requested',
    }),
    session('fx-s8', 'fx-cjk', '修复登录页面在移动端的布局问题', now - 2 * HOUR),
    session('fx-s9', 'fx-rtl', 'إصلاح خطأ في صفحة تسجيل الدخول', now - DAY),
    session('fx-s10', 'fx-archived', 'Ship launch checklist', now - 60 * DAY, {
      archived: true,
      status: 'completed',
    }),
  ]

  const installations: GithubInstallation[] = [
    {
      installationId: 1,
      account: {
        login: NORTHWIND,
        type: 'Organization',
        avatarUrl: 'https://example.com/avatars/404.png',
      },
    },
    { installationId: 2, account: { login: 'jo', type: 'User', avatarUrl: '' } },
  ]

  return tree(folders, sessions, installations)
}

/** Realistic upper bound: an org that has used Shuttle daily for a year. */
function huge(now: number): WorkspaceTree {
  const folders = Array.from({ length: 48 }, (_, index) =>
    folder(
      `fx-folder-${index}`,
      `Team ${index + 1}`,
      Array.from({ length: index % 4 }, (_repo, n) => repo(NORTHWIND, `service-${index}-${n}`)),
    ),
  )

  const sessions = Array.from({ length: 1284 }, (_, index) =>
    session(
      `fx-session-${index}`,
      `fx-folder-${index % folders.length}`,
      `Session ${index + 1}: tighten retries in the ingest worker`,
      now - index * 37 * MINUTE,
      { activity: index % 17 === 0 ? 'working' : 'idle' },
    ),
  )

  return tree(folders, sessions, [
    {
      installationId: 1,
      account: { login: NORTHWIND, type: 'Organization', avatarUrl: '' },
    },
  ])
}

export function workspaceFixture(mode: Exclude<FixtureMode, 'live'>, now: number): WorkspaceTree {
  switch (mode) {
    case 'worst':
      return worstCase(now)
    case 'empty':
      return tree([], [], [])
    case 'huge':
      return huge(now)

    default: {
      const exhaustive: never = mode
      return exhaustive
    }
  }
}
