import { z } from 'zod'

import { defineEvaluator } from '@swirls/looms/evaluator'

import type { InterjectionKind } from '../session/module'

const IntakeInputSchema = z.object({
  text: z.string(),
  activeWorkers: z.array(z.string()).default([]),
  hasConductor: z.boolean().default(true),
})

function classifyHeuristic(text: string): InterjectionKind {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  if (/^(stop|cancel|abort)\b/.test(lower) || lower === 'stop') {
    return 'stop'
  }

  if (
    trimmed.endsWith('?') ||
    /^(what|why|how|where|who|which|is|are|can|could|did|does|do)\b/i.test(trimmed)
  ) {
    return 'question'
  }

  if (
    /^(actually|no[, ]|wrong|don't|do not|instead|fix:|correct)\b/i.test(trimmed) ||
    /\b(not that|you should have)\b/i.test(trimmed)
  ) {
    return 'correction'
  }

  if (
    /^(also|btw|by the way|idea:|consider|prefer|please use|make sure|remember)\b/i.test(trimmed) ||
    /\b(constraint|prefer|use zod|use typescript)\b/i.test(trimmed)
  ) {
    return /^(must|never|always|don't|do not)\b/i.test(trimmed) ? 'constraint' : 'idea'
  }

  return 'task'
}

export const intake = defineEvaluator({
  name: 'intake',
  description: 'Classify a user interjection for the Shuttle session router',
  input: IntakeInputSchema,
  state: ({ text, activeWorkers }) =>
    [
      'Classify the user message for a coding agent session.',
      `Active workers: ${activeWorkers.length}`,
      `Message: ${text}`,
    ].join('\n'),
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What kind of interjection is this?',
      criteria: {
        question: 'Asking about status, code, or intent without changing the plan',
        idea: 'A soft suggestion or preference to fold into the brief',
        constraint: 'A hard requirement the agents must follow',
        correction: 'The user is correcting an agent mid-work and wants an interrupt',
        task: 'A new unit of work for the conductor to plan or delegate',
        stop: 'Stop the active agent or cancel work',
      },
    },
  },
  skipModel: ({ text }) => {
    const kind = classifyHeuristic(text)
    return {
      route: kind,
      reason: 'skipped',
      answers: {
        kind: { type: 'choice', value: kind },
      },
    }
  },
  route: ({ answers }) => {
    const kind = answers.kind
    const value = kind?.type === 'choice' ? kind.value : 'task'
    return { route: value, reason: 'model' }
  },
})
