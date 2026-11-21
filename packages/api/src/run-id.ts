/**
 * Run ids carry the organization they belong to: `o-<orgId>-<local>`. Every Durable Object is
 * named by its run id, so a run can find its organization's other runs from its own name, and a
 * request for a run can be checked against the caller's organization without a lookup.
 *
 * An id without the prefix belongs to no organization. Requests never reach such a run; they
 * exist only in unit tests and in data from before organizations.
 */

const ORG_ID = /^[A-Za-z0-9]{1,64}$/
const SCOPED = /^o-([A-Za-z0-9]{1,64})-(.+)$/

export interface ParsedRunId {
  readonly orgId: string | null
  /** The id without its organization prefix, such as `shuttle-workspace` or `session_<uuid>`. */
  readonly local: string
}

export function isOrgId(value: unknown): value is string {
  return typeof value === 'string' && ORG_ID.test(value)
}

/** The run id for `local` inside `orgId`. With no organization, `local` is returned unchanged. */
export function scopedRunId(orgId: string | null, local: string): string {
  if (orgId === null) {
    return local
  }

  if (!ORG_ID.test(orgId)) {
    throw new Error('invalid organization id')
  }

  return `o-${orgId}-${local}`
}

export function parseRunId(runId: string): ParsedRunId {
  const match = SCOPED.exec(runId)

  const orgId = match?.[1]
  const local = match?.[2]

  return orgId !== undefined && orgId !== '' && local !== undefined && local !== ''
    ? { orgId, local }
    : { orgId: null, local: runId }
}

export function orgOfRun(runId: string): string | null {
  return parseRunId(runId).orgId
}

/** The id of a run derived from `runId`, in the same organization. */
export function siblingRunId(runId: string, rename: (local: string) => string): string {
  const { orgId, local } = parseRunId(runId)

  return scopedRunId(orgId, rename(local))
}

const REFLECTION_PREFIX = 'reflect_'

/** A session's reflection run. */
export function reflectionRunId(sessionRunId: string): string {
  return siblingRunId(sessionRunId, (local) => `${REFLECTION_PREFIX}${local}`)
}

/** The session a reflection run reflects on. Any other run id is returned unchanged. */
export function sessionOfReflection(runId: string): string {
  return siblingRunId(runId, (local) =>
    local.startsWith(REFLECTION_PREFIX) ? local.slice(REFLECTION_PREFIX.length) : local,
  )
}

const PERSONAL = /^member-([A-Za-z0-9]{1,64})-(.+)$/

/**
 * A run that belongs to one person inside an organization, such as the list of their private
 * sessions. Only that person can reach it.
 */
export function personalRunId(orgId: string, userId: string, local: string): string {
  if (!ORG_ID.test(userId)) {
    throw new Error('invalid user id')
  }

  return scopedRunId(orgId, `member-${userId}-${local}`)
}

/** The person a personal run belongs to and its name without them, or null for any other run. */
export function parsePersonalRunId(
  runId: string,
): { readonly orgId: string; readonly userId: string; readonly local: string } | null {
  const { orgId, local } = parseRunId(runId)
  const match = PERSONAL.exec(local)

  const userId = match?.[1]
  const rest = match?.[2]

  return orgId !== null &&
    orgId !== '' &&
    userId !== undefined &&
    userId !== '' &&
    rest !== undefined &&
    rest !== ''
    ? { orgId, userId, local: rest }
    : null
}

/** A run id's name with neither its organization nor, for a personal run, its person. */
export function localRunName(runId: string): string {
  return parsePersonalRunId(runId)?.local ?? parseRunId(runId).local
}

/**
 * The names an organization's own runs go by inside it. A deployment can rename them (the
 * engine's `SHUTTLE_WORKSPACE_RUN_ID`, `SHUTTLE_PLAYBOOK_RUN_ID` and `SHUTTLE_PULLS_RUN_ID`), and
 * a page that builds its tenant itself is then given the same names.
 */
export interface RunNames {
  readonly workspace: string
  readonly playbook: string
  readonly pulls: string
}

export const DEFAULT_RUN_NAMES: RunNames = {
  workspace: 'shuttle-workspace',
  playbook: 'shuttle-playbook',
  pulls: 'shuttle-pulls',
}

/** An organization's runs as one of its members reaches them. */
export interface TenantRunIds {
  readonly workspace: string
  /** The member's own workspace run, which no one else in the organization opens. */
  readonly personal: string
  readonly pulls: string
  readonly playbook: string
}

/** The run ids of `orgId`'s workspace, playbook and pulls runs, and `userId`'s own workspace. */
export function tenantRunIds(
  orgId: string,
  userId: string,
  names: RunNames = DEFAULT_RUN_NAMES,
): TenantRunIds {
  return {
    workspace: scopedRunId(orgId, names.workspace),
    personal: personalRunId(orgId, userId, names.workspace),
    pulls: scopedRunId(orgId, names.pulls),
    playbook: scopedRunId(orgId, names.playbook),
  }
}
