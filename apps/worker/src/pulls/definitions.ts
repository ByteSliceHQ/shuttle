import { z } from 'zod'

import { DEFAULT_DEFINITION_VERSION, defineKind } from '@swirls/looms/core'

export const PullsInboxInputSchema = z.object({
  title: z.string().default('Shuttle pulls'),
})

export const pullsDefinition = defineKind('shuttle-pulls', {
  name: 'pulls',
  version: DEFAULT_DEFINITION_VERSION,
  description: 'Long-lived GitHub pull request inbox for Shuttle folders',
  input: PullsInboxInputSchema,
})
