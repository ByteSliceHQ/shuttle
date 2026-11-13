import {
  Bot,
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
  // Vendor agents the conductor delegates to in a hybrid session.
  codex: {
    label: 'Codex',
    icon: Bot,
    tone: 'text-route-idea',
    blurb: 'Codex on your subscription, taking tasks from the conductor.',
  },
  'claude-code': {
    label: 'Claude Code',
    icon: Bot,
    tone: 'text-route-question',
    blurb: 'Claude Code on your subscription, taking tasks from the conductor.',
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

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
}

/** Thread definitions whose turns run on the session's vendor agent. */
const VENDOR_RUN_DEFINITIONS = new Set(['conductor'])

function renamed(identity: AgentIdentity, label: string, model?: string): AgentIdentity {
  return {
    ...identity,
    label,
    role: {
      ...identity.role,
      label,
      blurb: model
        ? `${label} on your subscription, running ${model}.`
        : `${label} on your subscription.`,
    },
  }
}

/**
 * Renames threads that a vendor agent runs. A Codex or Claude Code session is still driven
 * through Shuttle's conductor thread, but it is that agent doing the work, so it carries its name.
 *
 * `vendorAgents` records what actually ran each thread. Before a thread's first step there is no
 * record yet, so `sessionHarness`, the agent the session is set to, names it in the meantime.
 */
export function withVendorAgents(
  identities: ReadonlyMap<string, AgentIdentity>,
  vendorAgents: Readonly<Record<string, { label: string; model?: string }>>,
  sessionHarness?: string,
): ReadonlyMap<string, AgentIdentity> {
  const pendingLabel = sessionHarness ? HARNESS_LABELS[sessionHarness] : undefined

  if (Object.keys(vendorAgents).length === 0 && !pendingLabel) {
    return identities
  }

  const next = new Map<string, AgentIdentity>()

  for (const [threadId, identity] of identities) {
    const agent = vendorAgents[threadId]

    if (agent) {
      next.set(threadId, renamed(identity, agent.label, agent.model))
    } else if (pendingLabel && VENDOR_RUN_DEFINITIONS.has(identity.definitionName)) {
      next.set(threadId, renamed(identity, pendingLabel))
    } else {
      next.set(threadId, identity)
    }
  }

  return next
}
