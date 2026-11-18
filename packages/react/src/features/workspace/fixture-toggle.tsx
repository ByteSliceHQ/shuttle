import { useEffect, useState } from 'react'

import { useFixtureMode } from './workspace-context'
import { FIXTURE_MODES, type FixtureMode } from './workspace-fixtures'

const LABELS = {
  live: 'Live data',
  worst: 'Worst case',
  empty: 'Empty',
  huge: '1,284 sessions',
} satisfies Record<FixtureMode, string>

const HIDDEN_KEY = 'shuttle.fixture.bar'

function readHidden(): boolean {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) !== '0'
  } catch {
    return true
  }
}

function writeHidden(hidden: boolean) {
  try {
    sessionStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0')
  } catch {
    // Private mode / quota — dismiss is ephemeral anyway.
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const tag = target.tagName

  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Dev-only chrome for stress-testing the workspace UI against fixture trees. */
export function FixtureToggle() {
  const [mode, setMode] = useFixtureMode()
  // Default hidden so the composer isn't covered; Shift+F reveals it.
  const [hidden, setHidden] = useState(readHidden)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== 'f' || !event.shiftKey) {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      event.preventDefault()

      setHidden((prev) => {
        const next = !prev
        writeHidden(next)
        return next
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (hidden) {
    return null
  }

  return (
    <div
      role="radiogroup"
      aria-label="Workspace data (Shift+F to hide)"
      title="Shift+F to hide"
      className="fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-neutral-300 p-0.5 font-[system-ui] text-[11px] whitespace-nowrap text-neutral-700 shadow-lg"
    >
      {FIXTURE_MODES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          onClick={() => setMode(option)}
          className={
            mode === option
              ? 'rounded-full bg-white px-2.5 py-1 text-neutral-900 shadow-sm'
              : 'rounded-full px-2.5 py-1 hover:text-neutral-900'
          }
        >
          {LABELS[option]}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          writeHidden(true)
          setHidden(true)
        }}
        className="rounded-full px-2 py-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
        aria-label="Hide fixtures bar"
        title="Hide (Shift+F)"
      >
        ×
      </button>
    </div>
  )
}
