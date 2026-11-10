import { z } from 'zod'

import { DEFAULT_DEFINITION_VERSION, defineKind } from '@swirls/looms/core'

export const WorkspaceInputSchema = z.object({
  title: z.string().default('Shuttle workspace'),
})

export const workspaceDefinition = defineKind('shuttle-workspace', {
  name: 'workspace',
  version: DEFAULT_DEFINITION_VERSION,
  description: 'Long-lived folders, GitHub installs, and session launches',
  input: WorkspaceInputSchema,
})
