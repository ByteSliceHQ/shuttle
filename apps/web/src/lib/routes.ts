import {
  CircleStop,
  HelpCircle,
  Lightbulb,
  ListChecks,
  ShieldAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react'

import type { InterjectionKind } from './session-feed'

export interface RouteStyle {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
  readonly dot: string
  readonly description: string
  readonly example: string
}

export const routeStyles: Record<InterjectionKind, RouteStyle> = {
  question: {
    label: 'Question',
    icon: HelpCircle,
    tone: 'text-route-question',
    dot: 'bg-route-question',
    description: 'A narrator answers; workers keep going',
    example: 'What is the worker doing right now?',
  },
  idea: {
    label: 'Idea',
    icon: Lightbulb,
    tone: 'text-route-idea',
    dot: 'bg-route-idea',
    description: 'Amends the brief and nudges agents',
    example: 'Also export the schema so callers can reuse it.',
  },
  constraint: {
    label: 'Constraint',
    icon: ShieldAlert,
    tone: 'text-route-constraint',
    dot: 'bg-route-constraint',
    description: 'Adds a hard rule to the brief',
    example: "Don't add new dependencies besides zod.",
  },
  correction: {
    label: 'Correction',
    icon: Undo2,
    tone: 'text-route-correction',
    dot: 'bg-route-correction',
    description: 'Interrupts the active worker mid-turn',
    example: 'Use z.string().min(1) instead of a regex.',
  },
  task: {
    label: 'Task',
    icon: ListChecks,
    tone: 'text-route-task',
    dot: 'bg-route-task',
    description: 'Hands new work to the conductor',
    example: 'Then add a test for the empty-name case.',
  },
  stop: {
    label: 'Stop',
    icon: CircleStop,
    tone: 'text-route-stop',
    dot: 'bg-route-stop',
    description: 'Stops the target agent',
    example: 'Stop, that approach is wrong.',
  },
}

/** Shown on RouteChip before `shuttle.routed` confirms intake. */
export function provisionalRouteSummary(kind: InterjectionKind): string {
  switch (kind) {
    case 'question':
      return 'answering without interrupting'
    case 'idea':
      return 'folding into the brief'
    case 'constraint':
      return 'adding to the brief'
    case 'correction':
      return 'interrupting the worker'
    case 'task':
      return 'steering the conductor'
    case 'stop':
      return 'stopping the agent'

    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}
