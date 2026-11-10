import { useFixtureMode } from '@/components/sidebar/workspace-context'
import type { FixtureMode } from '@/lib/workspace-fixtures'

const LABELS: Record<FixtureMode, string> = {
  live: 'Live data',
  worst: 'Worst case',
  empty: 'Empty',
  huge: '1,284 sessions',
}

/** Dev-only chrome for stress-testing the workspace UI against fixture trees. */
export function FixtureToggle() {
  const [mode, setMode] = useFixtureMode()

  return (
    <div
      role="radiogroup"
      aria-label="Workspace data"
      className="fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 gap-0.5 rounded-full bg-neutral-300 p-0.5 font-[system-ui] text-[11px] whitespace-nowrap text-neutral-700 shadow-lg"
    >
      {(Object.keys(LABELS) as FixtureMode[]).map((option) => (
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
    </div>
  )
}
