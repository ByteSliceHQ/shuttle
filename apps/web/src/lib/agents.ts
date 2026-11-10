import {
  Compass,
  Filter,
  Hammer,
  MessageCircleQuestion,
  Orbit,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

import type { ThreadNode } from '@swirls/looms/core'

export interface AgentRole {
  readonly label: string
  readonly icon: LucideIcon
  /** Tailwind text color class; backgrounds derive from `currentColor`. */
  readonly tone: string
  readonly blurb: string
}

const roles: Record<string, AgentRole> = {
  coding: {
    label: 'Session',
    icon: Orbit,
    tone: 'text-brand',
    blurb: 'Root mailbox that routes every interjection.',
  },
  conductor: {
    label: 'Conductor',
    icon: Compass,
    tone: 'text-route-task',
    blurb: 'Plans the work and delegates to workers.',
  },
  worker: {
    label: 'Worker',
    icon: Hammer,
    tone: 'text-route-idea',
    blurb: 'Edits code inside the sandbox.',
  },
  narrator: {
    label: 'Narrator',
    icon: MessageCircleQuestion,
    tone: 'text-route-question',
    blurb: 'Answers questions without interrupting the work.',
  },
  intake: {
    label: 'Intake',
    icon: Filter,
    tone: 'text-route-constraint',
    blurb: 'Classifies each message before routing.',
  },
  reflector: {
    label: 'Reflector',
    icon: Sparkles,
    tone: 'text-route-constraint',
    blurb: 'Mines the event history for lessons.',
  },
}

const fallbackRole: AgentRole = {
  label: 'Thread',
  icon: Workflow,
  tone: 'text-muted-foreground',
  blurb: 'Looms thread.',
}

export function agentRole(definitionName: string | undefined): AgentRole {
  return (definitionName ? roles[definitionName] : undefined) ?? fallbackRole
}

export interface AgentIdentity {
  readonly threadId: string
  readonly definitionName: string
  readonly label: string
  readonly role: AgentRole
}

/** Repeated definitions get ordinal suffixes ("Worker 2") in tree order. */
export function agentIdentities(root: ThreadNode | null): ReadonlyMap<string, AgentIdentity> {
  const identities = new Map<string, AgentIdentity>()
  const seen = new Map<string, number>()

  function visit(node: ThreadNode) {
    const role = agentRole(node.definitionName)
    const count = (seen.get(node.definitionName) ?? 0) + 1
    seen.set(node.definitionName, count)

    const base = role === fallbackRole ? node.definitionName || 'thread' : role.label

    identities.set(node.threadId, {
      threadId: node.threadId,
      definitionName: node.definitionName,
      label: count > 1 ? `${base} ${count}` : base,
      role,
    })

    for (const child of node.children) {
      visit(child)
    }
  }

  if (root) {
    visit(root)
  }

  return identities
}
