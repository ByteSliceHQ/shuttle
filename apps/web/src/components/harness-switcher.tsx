import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  fetchConnections,
  setDefaultHarness,
  type ConnectionsState,
  type HarnessId,
} from '@/lib/api'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const SHUTTLE_LABEL = 'Shuttle'

/** Picks which agent runs the session: Shuttle's own loop, or a connected subscription. */
export function HarnessSwitcher({
  value,
  onChange,
  disabled = false,
  side = 'top',
}: {
  value: HarnessId
  onChange: (harness: HarnessId) => void
  disabled?: boolean
  /** Which way the menu opens: up from a composer at the bottom, down from a form. */
  side?: 'top' | 'bottom'
}) {
  const [state, setState] = useState<ConnectionsState | null>(null)

  const reload = useCallback(() => {
    fetchConnections().then(setState, () => setState(null))
  }, [])

  useEffect(reload, [reload])

  const connections = state?.connections ?? []
  const label = connections.find((entry) => entry.harness === value)?.label ?? SHUTTLE_LABEL

  return (
    <DropdownMenu onOpenChange={(open) => (open ? reload() : undefined)}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Agent"
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50"
      >
        <span className="truncate">{value === 'shuttle' ? SHUTTLE_LABEL : label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // The trigger sits at the right of a session composer and the left of a new-session form.
        align={side === 'top' ? 'end' : 'start'}
        side={side}
        sideOffset={8}
        className="w-60"
      >
        <DropdownMenuLabel>Run the session on</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as HarnessId)}>
          <DropdownMenuRadioItem value="shuttle">
            {SHUTTLE_LABEL}
            <span className="text-muted-foreground ml-auto text-[10px]">OpenRouter</span>
          </DropdownMenuRadioItem>
          {connections.map((connection) => (
            <DropdownMenuRadioItem
              key={connection.harness}
              value={connection.harness}
              disabled={!connection.connected}
            >
              {connection.label}
              <span className="text-muted-foreground ml-auto text-[10px]">
                {connection.connected ? 'Your subscription' : 'Not connected'}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/connections">Manage connections</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The agent new sessions start on, for forms that create a session. `save` must finish before
 * the session is launched: a session takes the default on its first turn.
 */
export function useDefaultHarness(): {
  harness: HarnessId
  setHarness: (harness: HarnessId) => void
  save: () => Promise<unknown>
} {
  const [harness, setHarness] = useState<HarnessId>('shuttle')
  const [chosen, setChosen] = useState(false)

  useEffect(() => {
    fetchConnections().then(
      (state) => setHarness((current) => (chosen ? current : state.defaultHarness)),
      () => {},
    )
  }, [chosen])

  return {
    harness,
    setHarness: (next) => {
      setChosen(true)
      setHarness(next)
    },
    save: () => (chosen ? setDefaultHarness(harness) : Promise.resolve()),
  }
}
