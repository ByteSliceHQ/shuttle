import { z } from 'zod'

import { DEFAULT_DEFINITION_VERSION, defineKind } from '@swirls/looms/core'

const LessonSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.string().optional(),
})

export const ShuttleSessionInputSchema = z.object({
  goal: z.string(),
  repoUrl: z.string().nullable().optional(),
  playbookRunId: z.string().nullable().optional(),
  playbookVersion: z.number().optional(),
  lessons: z.array(LessonSchema).optional(),
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
