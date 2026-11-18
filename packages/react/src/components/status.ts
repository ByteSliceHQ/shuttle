import { cn } from '../lib/cn'

export type StatusTone = 'running' | 'delegating' | 'waiting' | 'completed' | 'failed' | 'idle'

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'working':
    case 'running':
    case 'pending':
      return 'running'
    case 'delegating':
      return 'delegating'
    case 'needs_input':
    case 'waiting':
    case 'blocked':
      return 'waiting'
    case 'completed':
    case 'approved':
      return 'completed'
    case 'failed':
    case 'error':
    case 'rejected':
      return 'failed'
    default:
      return 'idle'
  }
}

const textClass: Record<StatusTone, string> = {
  running: 'text-status-running',
  delegating: 'text-status-running/80',
  waiting: 'text-status-waiting',
  completed: 'text-status-completed',
  failed: 'text-status-failed',
  idle: 'text-muted-foreground',
}

const dotClass: Record<StatusTone, string> = {
  running: 'bg-status-running',
  delegating: 'border-status-running/60 border-[1.5px]',
  waiting: 'bg-status-waiting',
  completed: 'bg-status-completed',
  failed: 'bg-status-failed',
  idle: 'border-muted-foreground/45 border',
}

const LABELS = new Map<string, string>(
  Object.entries({
    working: 'Working',
    running: 'Working',
    starting: 'Starting',
    delegating: 'Delegating',
    needs_input: 'Needs input',
    waiting: 'Waiting',
    idle: 'Idle',
    completed: 'Completed',
    failed: 'Failed',
    error: 'Failed',
    cancelled: 'Cancelled',
  }),
)

export function statusLabel(status: string): string {
  return LABELS.get(status) ?? status
}

export function statusClass(status: string): string {
  return textClass[statusTone(status)]
}

export function statusDotClass(status: string): string {
  const tone = statusTone(status)
  return cn('inline-block size-1.5 shrink-0 rounded-full', dotClass[tone])
}

export function isLive(status: string): boolean {
  return statusTone(status) === 'running'
}
