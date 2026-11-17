import { useQuery } from '@tanstack/react-query'
import { RotateCw, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'

import type { SandboxPlace } from '@shuttle/api'

import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/panel'
import { cn } from '../../lib/cn'
import { possessive, useApi, useOrgPeople, useShuttleHost, useTenant } from '../../shuttle'
import { sandboxTerminalUrl } from './sandbox'
import { terminalFontFamily, terminalTheme } from './terminal-theme'

/** What Shuttle sends down the terminal socket in place of output when something is wrong. */
const TerminalNotice = z.object({ type: z.string().optional(), error: z.string().optional() })

type Status = 'connecting' | 'connected' | 'closed'

const FONT_SIZE = 12.5

const dim = (text: string) => `\u001B[2m${text}\u001B[0m`

export function TerminalViewer({
  runId,
  folderId,
  cwd,
}: {
  runId: string
  folderId?: string
  cwd: string
}) {
  const host = useShuttleHost()
  const api = useApi()
  const containerRef = useRef<HTMLDivElement>(null)
  const reconnectRef = useRef<() => void>(() => {})
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  // Asked whenever the terminal is opened, since the session may have moved since.
  const { data: place = null } = useQuery(
    api.sandbox.place.get.queryOptions({ input: { id: runId }, staleTime: 0 }),
  )

  useEffect(() => {
    const el = containerRef.current

    if (!el) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let dispose = () => {}

    async function start(element: HTMLDivElement) {
      const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-webgl'),
        import('@xterm/xterm/css/xterm.css'),
      ])

      const fontFamily = terminalFontFamily()

      // The cell size is measured from the font when the terminal opens. Measured before the web
      // font has loaded, every character afterwards sits in a cell of the wrong width.
      await document.fonts.load(`${FONT_SIZE}px ${fontFamily}`).catch(() => {})

      if (disposed) {
        return
      }

      const term = new Terminal({
        fontFamily,
        fontSize: FONT_SIZE,
        lineHeight: 1.3,
        fontWeight: '400',
        fontWeightBold: '600',
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'outline',
        scrollback: 10_000,
        macOptionIsMeta: true,
        // Bold stays the colour it was given, as modern terminals do.
        drawBoldTextInBrightColors: false,
        // Lifts colours a program picks that would be unreadable on this background.
        minimumContrastRatio: 4.5,
        theme: terminalTheme(),
      })

      const fit = new FitAddon()

      term.loadAddon(fit)
      term.open(element)

      // The GPU renderer draws box characters and dense output cleanly. Where a browser has no
      // WebGL, or loses the context, xterm's own renderer carries on.
      try {
        const webgl = new WebglAddon()

        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // No WebGL here.
      }

      const refit = () => {
        // A hidden tab has no size; fitting to it would shrink the shell to nothing.
        if (element.clientWidth > 0 && element.clientHeight > 0) {
          fit.fit()
        }
      }

      refit()
      term.focus()

      const send = (data: string) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(data)
        }
      }

      const connect = () => {
        setStatus('connecting')
        setError(null)

        const opened = new WebSocket(
          sandboxTerminalUrl(
            host,
            { runId, folderId },
            { cwd: cwd || undefined, cols: term.cols, rows: term.rows },
          ),
        )

        opened.binaryType = 'arraybuffer'
        socket = opened

        opened.addEventListener('open', () => {
          if (!disposed) {
            setStatus('connected')
            // The size may have changed while the sandbox was waking.
            send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          }
        })

        opened.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') {
            term.write(new Uint8Array(event.data as ArrayBuffer))

            return
          }

          // Text starting with a brace may be a notice from Shuttle rather than output.
          if (event.data.startsWith('{')) {
            try {
              const message = TerminalNotice.parse(JSON.parse(event.data))

              if (message.type === 'error') {
                if (message.error === 'container-mode-required') {
                  setUnsupported(true)
                } else {
                  setError(message.error ?? 'Terminal error')
                }

                return
              }
            } catch {
              // Output after all.
            }
          }

          term.write(event.data)
        })

        opened.addEventListener('close', (event: CloseEvent) => {
          if (disposed || socket !== opened) {
            return
          }

          if (event.code === 1011 || event.reason.includes('container-mode-required')) {
            setUnsupported(true)

            return
          }

          setStatus('closed')
          term.write(`\r\n${dim('Disconnected. Press Enter to reconnect.')}\r\n`)
        })
      }

      reconnectRef.current = () => {
        socket?.close()
        term.reset()
        connect()
        term.focus()
      }

      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(data)
        } else if (socket?.readyState === WebSocket.CLOSED && data === '\r') {
          reconnectRef.current()
        }
      })

      term.onResize(({ cols, rows }) => send(JSON.stringify({ type: 'resize', cols, rows })))

      let frame = 0

      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(refit)
      })

      resizeObserver.observe(element)

      dispose = () => {
        cancelAnimationFrame(frame)
        resizeObserver.disconnect()
        term.dispose()
      }

      connect()
    }

    start(el).catch((cause: unknown) => {
      if (!disposed) {
        setError(cause instanceof Error ? cause.message : 'Failed to start terminal')
      }
    })

    return () => {
      disposed = true
      socket?.close()
      dispose()
    }
  }, [host, runId, folderId, cwd])

  if (unsupported) {
    return (
      <EmptyState icon={<SquareTerminal />} title="Terminal unavailable">
        This deployment runs sessions without a sandbox, so there is no shell to open.
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalBar
        place={place}
        status={status}
        error={error}
        onReconnect={() => reconnectRef.current()}
      />
      {/* The padding is on a wrapper: xterm sizes itself to the element it is opened in. */}
      <div className="bg-background min-h-0 flex-1 py-2 pr-1 pl-3">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
}

/** Says whose sandbox the shell is in, whether the session's files are there, and its state. */
function TerminalBar({
  place,
  status,
  error,
  onReconnect,
}: {
  place: SandboxPlace | null
  status: Status
  error: string | null
  onReconnect: () => void
}) {
  const me = useTenant().user.id
  const people = useOrgPeople()

  const where = place?.personal ? 'Your sandbox' : 'Session sandbox'

  const elsewhere =
    place?.personal && !place.here
      ? place.holderId
        ? `This session's files are in ${possessive(place.holderId, me, people)} sandbox, not here.`
        : 'This session has not worked in a sandbox yet, so its files are not here.'
      : null

  const state = error
    ? error
    : status === 'connecting'
      ? place?.personal
        ? 'Waking your sandbox…'
        : 'Connecting…'
      : status === 'closed'
        ? 'Disconnected'
        : null

  return (
    <div className="text-muted-foreground flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          error || status === 'closed'
            ? 'bg-status-failed'
            : status === 'connected'
              ? 'bg-status-completed'
              : 'bg-status-waiting animate-pulse',
        )}
      />
      <span className="text-foreground shrink-0 font-medium">{where}</span>
      {elsewhere ? (
        <span className="min-w-0 truncate" title={elsewhere}>
          {elsewhere}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5" role="status">
        {state}
        {error || status === 'closed' ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={onReconnect}
          >
            <RotateCw />
            Reconnect
          </Button>
        ) : null}
      </span>
    </div>
  )
}
