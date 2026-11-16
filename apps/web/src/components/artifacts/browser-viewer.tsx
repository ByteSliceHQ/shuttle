import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/panel'
import { fetchPreviewAddress, type PreviewAddress, resolveBrowserTarget } from '@/lib/sandbox'
import { tabTitleForKind } from '@/lib/session-tabs'

export function BrowserViewer({
  runId,
  target,
  onRetarget,
}: {
  runId: string
  target: string
  onRetarget: (title: string, nextTarget: string) => void
}) {
  // Where this session's sandbox answers previews.
  const [preview, setPreview] = useState<PreviewAddress>()

  useEffect(() => {
    let current = true

    fetchPreviewAddress(runId).then(
      (address) => {
        if (current) {
          setPreview(address)
        }
      },
      () => {},
    )

    return () => {
      current = false
    }
  }, [runId])

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [draft, setDraft] = useState(target)
  const [syncedTarget, setSyncedTarget] = useState(target)
  const [history, setHistory] = useState<string[]>(() => (target ? [target] : []))
  const [index, setIndex] = useState(0)
  const [blocked, setBlocked] = useState(false)

  // Keep the address bar in sync when the tab target changes externally.
  if (target !== syncedTarget) {
    setSyncedTarget(target)
    setDraft(target)
  }

  const src = useMemo(
    () => resolveBrowserTarget(target, preview?.label, preview?.host),
    [target, preview],
  )

  function navigate(next: string) {
    const resolved = next.trim()

    if (!resolved) {
      return
    }

    setBlocked(false)
    onRetarget(tabTitleForKind('browser', resolved), resolved)
    setHistory((prev) => [...prev.slice(0, index + 1), resolved])
    setIndex((prev) => prev + 1)
  }

  function go(delta: number) {
    const nextIndex = index + delta
    const entry = history[nextIndex]

    if (!entry) {
      return
    }

    setIndex(nextIndex)
    setDraft(entry)
    onRetarget(tabTitleForKind('browser', entry), entry)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={index <= 0}
          onClick={() => go(-1)}
          aria-label="Back"
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={index >= history.length - 1}
          onClick={() => go(1)}
          aria-label="Forward"
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            const frame = iframeRef.current

            if (frame && src) {
              frame.src = src
            }
          }}
          aria-label="Reload"
        >
          <RotateCw />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(draft)
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Port or URL"
            aria-label="Browser address"
            className="h-7 w-full rounded-md font-mono text-[11px]"
          />
        </form>
        {src ? (
          <Button variant="ghost" size="icon-sm" asChild aria-label="Open externally">
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink />
            </a>
          </Button>
        ) : null}
      </div>

      {!src ? (
        <EmptyState icon={<Globe />} title="Open a preview">
          Enter a port (e.g. <code className="font-mono">3000</code> or{' '}
          <code className="font-mono">localhost:3000</code>). Both proxy through the sandbox
          container — not your Mac loopback.
        </EmptyState>
      ) : blocked ? (
        <EmptyState icon={<Globe />} title="Page blocked framing">
          This site refuses to load in an iframe. Open it externally instead.
        </EmptyState>
      ) : (
        <iframe
          ref={iframeRef}
          title="Browser preview"
          src={src}
          className="bg-background min-h-0 flex-1 border-0"
          // Scripts + same-origin are required for local Vite HMR previews.
          // eslint-disable-next-line react/iframe-missing-sandbox -- intentional for sandbox previews
          sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin allow-downloads"
          onError={() => setBlocked(true)}
        />
      )}
    </div>
  )
}
