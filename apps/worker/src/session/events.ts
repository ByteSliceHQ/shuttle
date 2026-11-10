import { z } from 'zod'

export const UserSaidSchema = z.object({
  messageId: z.string(),
  text: z.string(),
  /** When set, skip intake and force this route. */
  forceKind: z.enum(['question', 'idea', 'constraint', 'correction', 'task', 'stop']).optional(),
  targetThreadId: z.string().optional(),
})

export const IntakeStartedSchema = z.object({
  messageId: z.string(),
  childThreadId: z.string(),
})

export const RoutedSchema = z.object({
  messageId: z.string(),
  kind: z.enum(['question', 'idea', 'constraint', 'correction', 'task', 'stop']),
  targetThreadId: z.string().nullable(),
  summary: z.string(),
  briefVersion: z.number().optional(),
})

export const BriefAmendedSchema = z.object({
  version: z.number(),
  text: z.string(),
  sourceMessageId: z.string(),
})

export const PlaybookLoadedSchema = z.object({
  version: z.number(),
  lessons: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      scope: z.string().optional(),
    }),
  ),
})

export const NarratorSpawnedSchema = z.object({
  messageId: z.string(),
  childThreadId: z.string(),
})

export const ConductorSpawnedSchema = z.object({
  childThreadId: z.string(),
})

export const ReflectionLaunchedSchema = z.object({
  runId: z.string(),
})

export const RerouteSchema = z.object({
  messageId: z.string(),
  kind: z.enum(['question', 'idea', 'constraint', 'correction', 'task', 'stop']),
  targetThreadId: z.string().optional(),
})
