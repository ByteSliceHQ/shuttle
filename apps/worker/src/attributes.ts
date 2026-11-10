import { defineRunAttributes } from '@swirls/looms/core'

export const shuttleAttributes = defineRunAttributes({
  sessionId: { index: true },
  repo: { index: true },
  playbookVersion: {},
  kind: { index: true },
})
