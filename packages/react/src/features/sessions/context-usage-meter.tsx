import { Minus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useProjection, useRunStore } from '@swirls/looms/react'

import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { cn } from '../../lib/cn'
import {
  buildContextUsageReport,
  contextUsage,
  formatTokenCount,
  formatTokenTotal,
  type ContextUsageReport,
} from './context-usage'
import { getOpenRouterModel, type OpenRouterModelId } from './llm-models'
import { sessionFeed } from './session-feed'

const HOVER_OPEN_DELAY = 180
const HOVER_CLOSE_DELAY = 140
const WARN_PERCENT = 80
const CRITICAL_PERCENT = 90

function supportsFineHover(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
}

export function ContextUsage({ runId, modelId }: { runId: string; modelId: OpenRouterModelId }) {
  const [open, setOpen] = useState(false)
  const pinnedRef = useRef(false)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const store = useRunStore(runId)
  const usage = useProjection(store, contextUsage)
  const feed = useProjection(store, sessionFeed)
  const model = getOpenRouterModel(modelId)
  const windowSize = model?.context ?? 200_000
  const report = buildContextUsageReport(usage, feed, windowSize)
  const empty = report.used === 0 && report.segments.length === 0

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }

    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  if (empty) {
    return null
  }

  const showInlinePercent = report.percent >= WARN_PERCENT

  function scheduleHoverOpen() {
    if (!supportsFineHover()) {
      return
    }

    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }

    if (!open && openTimerRef.current === null) {
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null
        setOpen(true)
      }, HOVER_OPEN_DELAY)
    }
  }

  function scheduleHoverClose() {
    if (!supportsFineHover() || pinnedRef.current) {
      return
    }

    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }

    if (closeTimerRef.current === null) {
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        setOpen(false)
      }, HOVER_CLOSE_DELAY)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimers()

        if (!next) {
          pinnedRef.current = false
        }

        setOpen(next)
      }}
    >
      <PopoverTrigger
        aria-label={`Context usage: ${report.percent}% full`}
        onPointerEnter={scheduleHoverOpen}
        onPointerLeave={scheduleHoverClose}
        onClick={(event) => {
          clearTimers()

          if (open && !pinnedRef.current) {
            event.preventDefault()
            pinnedRef.current = true
            return
          }

          pinnedRef.current = !open
        }}
        className={cn(
          'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy inline-flex h-7 shrink-0 items-center justify-center rounded-md text-xs tabular-nums transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97]',
          showInlinePercent ? 'gap-1.5 px-2' : 'w-7',
          report.percent >= CRITICAL_PERCENT && 'text-status-failed hover:text-status-failed',
          report.percent >= WARN_PERCENT &&
            report.percent < CRITICAL_PERCENT &&
            'text-status-waiting hover:text-status-waiting',
        )}
      >
        <ContextRing percent={report.percent} hasUsage={report.used > 0} />
        {showInlinePercent ? <span>{report.percent}%</span> : null}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className="w-[20.5rem]"
        onPointerEnter={() => {
          if (closeTimerRef.current !== null) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
          }
        }}
        onPointerLeave={scheduleHoverClose}
        onOpenAutoFocus={(event) => {
          if (!pinnedRef.current) {
            event.preventDefault()
          }
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextUsagePanel report={report} />
      </PopoverContent>
    </Popover>
  )
}

function ContextUsagePanel({ report }: { report: ContextUsageReport }) {
  const usedLabel = `${report.estimated ? '~' : ''}${formatTokenCount(report.used)}`
  const windowLabel = formatTokenTotal(report.window)

  return (
    <div className="p-3.5">
      <div className="flex items-center gap-2">
        <h2 className="text-foreground text-[13px] font-medium">Context Usage</h2>
        <span className="text-muted-foreground/70 text-[11px]">
          {report.estimated ? 'Estimated' : 'Last model call'}
        </span>
        <PopoverClose
          aria-label="Close"
          className="text-muted-foreground hover:bg-accent hover:text-foreground ease-snappy ml-auto inline-flex size-6 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.95]"
        >
          <Minus className="size-3.5" />
        </PopoverClose>
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-foreground text-[12.5px] font-medium tabular-nums">
          {report.percent}% Full
        </p>
        <p className="text-muted-foreground text-[12px] tabular-nums">
          {usedLabel} / {windowLabel} Tokens
        </p>
      </div>

      <SegmentedBar report={report} className="mt-2" />

      {report.segments.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {report.segments.map((segment) => (
            <li key={segment.id} className="flex items-center gap-2 text-[12px]">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: segment.color }}
              />
              <span className="text-foreground/90 min-w-0 flex-1 truncate">{segment.label}</span>
              <span className="text-muted-foreground tabular-nums">
                {report.estimated ? '~' : ''}
                {formatTokenCount(segment.tokens)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {report.totals.input > 0 || report.totals.output > 0 ? (
        <p className="text-muted-foreground/70 mt-3 border-t pt-2.5 text-[11px] tabular-nums">
          Session · in {formatTokenCount(report.totals.input)} · out{' '}
          {formatTokenCount(report.totals.output)}
        </p>
      ) : null}
    </div>
  )
}

function SegmentedBar({ report, className }: { report: ContextUsageReport; className?: string }) {
  const fill = Math.min(100, Math.max(report.used > 0 ? 2 : 0, (report.used / report.window) * 100))

  return (
    <div
      className={cn('bg-muted/80 flex h-1.5 w-full overflow-hidden rounded-full', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={report.percent}
      aria-label="Context window fill"
    >
      <div
        className="flex h-full gap-px overflow-hidden rounded-full"
        style={{ width: `${fill}%` }}
      >
        {report.segments.map((segment) => {
          const share = report.used > 0 ? (segment.tokens / report.used) * 100 : 0

          return (
            <div
              key={segment.id}
              title={`${segment.label}: ${formatTokenCount(segment.tokens)}`}
              className="h-full min-w-[3px]"
              style={{
                width: `${share}%`,
                backgroundColor: segment.color,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

const RING_RADIUS = 5.75
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function ContextRing({ percent, hasUsage }: { percent: number; hasUsage: boolean }) {
  const ratio = hasUsage ? Math.min(1, Math.max(0.06, percent / 100)) : 0
  const offset = RING_CIRCUMFERENCE * (1 - ratio)

  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" fill="none">
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth="1.75"
      />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={offset}
        className="ease-snappy transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  )
}
