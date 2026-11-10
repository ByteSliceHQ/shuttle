import { cn } from './cn'

type StatusTone = 'running' | 'waiting' | 'completed' | 'failed' | 'idle'

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'running':
    case 'pending':
      return 'running'
    case 'waiting':
    case 'blocked':
      return 'waiting'
    case 'completed':
    case 'approved':
      return 'completed'
    case 'failed':
    case 'rejected':
      return 'failed'
    default:
      return 'idle'
  }
}

const textClass: Record<StatusTone, string> = {
  running: 'text-status-running',
  waiting: 'text-status-waiting',
  completed: 'text-status-completed',
  failed: 'text-status-failed',
  idle: 'text-status-cancelled',
}

const dotClass: Record<StatusTone, string> = {
  running: 'bg-status-running',
  waiting: 'bg-status-waiting',
  completed: 'bg-status-completed',
  failed: 'bg-status-failed',
  idle: 'bg-status-cancelled',
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
