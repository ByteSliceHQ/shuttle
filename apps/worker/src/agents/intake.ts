import { z } from 'zod'

import { defineEvaluator } from '@swirls/looms/evaluator'

import type { InterjectionKind } from '../session/module'

const IntakeInputSchema = z.object({
  text: z.string(),
  activeWorkers: z.array(z.string()).default([]),
  hasConductor: z.boolean().default(true),
})

/**
 * Unambiguous stop commands ("stop", "cancel that", "abort now!") that can skip
 * intake. Anything longer ("stop using tailwind") still goes through intake.
 */
export function isHardStop(text: string): boolean {
  return /^(stop|cancel|abort|halt)(\s+(it|that|this|now|please|everything|all|the\s+workers?|workers?))*\s*[.!]*$/i.test(
    text.trim(),
  )
}

/** Local classifier used when Jev is unavailable (no TYPESAFE_AI_API_KEY). */
export function classifyHeuristic(text: string): InterjectionKind {
  const trimmed = text.trim()

  if (isHardStop(trimmed)) {
    return 'stop'
  }

  // "stop using tailwind" redirects the work rather than halting it.
  if (/^(stop|cancel|abort|halt)\b/i.test(trimmed)) {
    return 'correction'
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

/** Pull the user message back out of the evaluator state string. */
export function parseIntakeMessage(state: string): string {
  const marker = '\nMessage: '
  const index = state.lastIndexOf(marker)
  return index >= 0 ? state.slice(index + marker.length) : state
}

export const intake = defineEvaluator({
  name: 'intake',
  description: 'Classify a user interjection for the Shuttle session router',
  // TypeSafe Jev via vercelEvaluator; overridden by adapter default / JEV_MODEL.
  model: 'jev-latest',
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
  // Fast-path only: cancel/stop should not wait on a model round-trip.
  // Everything else goes through Jev (or the heuristic stub when no API key).
  skipModel: ({ text }) => {
    if (!isHardStop(text)) {
      return undefined
    }

    const kind = 'stop' as const

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
