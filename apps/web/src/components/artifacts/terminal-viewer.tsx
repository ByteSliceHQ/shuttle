import { SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { sandboxTerminalUrl } from '@/lib/sandbox'

export function TerminalViewer({
  runId,
  folderId,
  cwd,
}: {
  runId: string
  folderId?: string
  cwd: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    const el = containerRef.current

    if (!el) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let terminal: { dispose: () => void; focus: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null

    async function start() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ])

        await import('@xterm/xterm/css/xterm.css')

        if (disposed || !el) {
          return
        }

        const term = new Terminal({
          cursorBlink: true,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          theme: {
            background: 'transparent',
            foreground: 'var(--foreground)',
            cursor: 'var(--foreground)',
            selectionBackground: 'color-mix(in oklab, var(--foreground) 20%, transparent)',
          },
          convertEol: true,
        })

        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(el)
        fit.fit()
        term.focus()
        terminal = term

        const dims = fit.proposeDimensions()

        const url = sandboxTerminalUrl(
          { runId, folderId },
          {
            cwd: cwd || undefined,
            cols: dims?.cols ?? 80,
            rows: dims?.rows ?? 24,
          },
        )

        socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'

        const onOpen = () => {
          term.writeln('\x1b[90mConnected to sandbox terminal\x1b[0m')
        }

        const onMessage = (event: MessageEvent) => {
          if (typeof event.data === 'string') {
            if (event.data.startsWith('{')) {
              try {
                const message = JSON.parse(event.data) as { type?: string; error?: string }

                if (message.type === 'error') {
                  if (message.error === 'container-mode-required') {
                    setUnsupported(true)
                  } else {
                    setError(message.error ?? 'Terminal error')
                  }
                }
              } catch {
                term.write(event.data)
              }
            } else {
              term.write(event.data)
            }

            return
          }

          term.write(new Uint8Array(event.data as ArrayBuffer))
        }

        const onError = () => {
          if (!disposed) {
            setError('Terminal connection failed')
          }
        }

        const onClose = (event: CloseEvent) => {
          if (disposed) {
            return
          }

          if (event.code === 1011 || event.reason.includes('container-mode-required')) {
            setUnsupported(true)

            return
          }

          term.writeln('\r\n\x1b[90mDisconnected\x1b[0m')
        }

        socket.addEventListener('open', onOpen)
        socket.addEventListener('message', onMessage)
        socket.addEventListener('error', onError)
        socket.addEventListener('close', onClose)

        term.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(data)
          }
        })

        term.onResize(({ cols, rows }) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
        })

        resizeObserver = new ResizeObserver(() => {
          fit.fit()
        })

        resizeObserver.observe(el)
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'Failed to start terminal')
        }
      }
    }

    void start()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      socket?.close()
      terminal?.dispose()
    }
  }, [runId, folderId, cwd])

  if (unsupported) {
    return (
      <EmptyState icon={<SquareTerminal />} title="Container mode required">
        Terminal needs <code className="font-mono">SHUTTLE_WORKSPACE_MODE=container</code> and
        Docker.
      </EmptyState>
    )
  }

  if (error) {
    return (
      <EmptyState icon={<SquareTerminal />} title="Terminal unavailable">
        {error}
      </EmptyState>
    )
  }

  return <div ref={containerRef} className="h-full min-h-0 w-full p-2" />
}
