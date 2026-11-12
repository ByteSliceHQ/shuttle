import { z } from 'zod'

import { DEFAULT_DEFINITION_VERSION, defineKind } from '@swirls/looms/core'

const LessonSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.string().optional(),
})

const LinkedRepoSchema = z.object({
  installationId: z.number(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
})

const PullRefSchema = z.object({
  fullName: z.string(),
  number: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
})

export const ShuttleSessionInputSchema = z.object({
  goal: z.string(),
  repoUrl: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  workspaceRunId: z.string().nullable().optional(),
  sandboxName: z.string().nullable().optional(),
  repos: z.array(LinkedRepoSchema).optional(),
  playbookRunId: z.string().nullable().optional(),
  playbookVersion: z.number().optional(),
  lessons: z.array(LessonSchema).optional(),
  pull: PullRefSchema.optional(),
})

export type ShuttleSessionInput = z.infer<typeof ShuttleSessionInputSchema>

export function defineShuttleSession(def: {
  readonly name: string
  readonly description?: string
  readonly version?: string
}) {
  return defineKind('shuttle-session', {
    name: def.name,
    version: def.version ?? DEFAULT_DEFINITION_VERSION,
    description: def.description,
    input: ShuttleSessionInputSchema,
  })
}

export const codingSession = defineShuttleSession({
  name: 'coding',
  description: 'Root coding session with intake routing, brief, and conductor',
})

export const reviewSession = defineShuttleSession({
  name: 'review',
  description: 'Pull request review session with reviewer agent',
})
