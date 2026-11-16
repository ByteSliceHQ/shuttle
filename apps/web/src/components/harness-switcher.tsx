import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  DEFAULT_TEAM,
  fetchConnections,
  setSessionDefaults,
  signedInAt,
  type Connection,
  type ConnectionsState,
  type HarnessId,
  type SignInPlace,
  type Team,
  type TeamPreset,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { canRunAt, effectiveTeam, withTeamChange } from '@/lib/team'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const SHUTTLE_LABEL = 'Shuttle'

const PRESET_LABELS: Record<TeamPreset, string> = {
  none: 'Conductor decides',
  'codex-builds-claude-reviews': 'Codex builds, Claude reviews',
  'claude-builds-codex-reviews': 'Claude builds, Codex reviews',
  'claude-plans-codex-implements': 'Claude plans, Codex implements',
}

const PRESETS = Object.keys(PRESET_LABELS) as TeamPreset[]

/** What the picker shows for a Shuttle session, naming the vendor agents on its team. */
function teamLabel(team: Team | undefined): string {
  const members = [
    team?.codex ? 'Codex' : null,
    team?.claudeCode ? 'Claude' : null,
    team?.cursor ? 'Cursor' : null,
  ].filter(Boolean)

  return members.length > 0 ? `${SHUTTLE_LABEL} + ${members.join(' + ')}` : SHUTTLE_LABEL
}

function teamKey(harness: Connection['harness']): 'codex' | 'claudeCode' | 'cursor' {
  switch (harness) {
    case 'codex':
      return 'codex'
    case 'claude-code':
      return 'claudeCode'
    case 'cursor':
      return 'cursor'

    default: {
      const exhaustive: never = harness

      return exhaustive
    }
  }
}

/**
 * How an agent stands where the session runs, for the picker. An agent signed in only at the
 * other place can still be picked: the message box then offers to sign in where it runs.
 */
function agentStatus(
  connection: Connection,
  place: SignInPlace | null | undefined,
): { text: string; warn: boolean } {
  const there = place ? signedInAt(connection, place) : null

  if (there === true || (there === null && connection.connected)) {
    return { text: 'Your subscription', warn: false }
  }

  if (!connection.connected) {
    return { text: 'Not connected', warn: false }
  }

  return { text: place === 'local' ? 'Cloud only' : 'This machine only', warn: true }
}

/** Picks which agent runs the session: Shuttle's own loop, or a connected subscription. */
export function HarnessSwitcher({
  value,
  onChange,
  team,
  onTeamChange,
  disabled = false,
  side = 'top',
  place,
}: {
  value: HarnessId
  onChange: (harness: HarnessId) => void
  /** Who Shuttle's conductor may delegate to. Only applies to a Shuttle session. */
  team?: Team
  onTeamChange?: (team: Team) => void
  disabled?: boolean
  /** Which way the menu opens: up from a composer at the bottom, down from a form. */
  side?: 'top' | 'bottom'
  /** Where the session runs, so the picker says whether each agent is signed in there. */
  place?: SignInPlace | null
}) {
  const [state, setState] = useState<ConnectionsState | null>(null)

  const reload = useCallback(() => {
    fetchConnections().then(setState, () => setState(null))
  }, [])

  useEffect(reload, [reload])

  const connections = state?.connections ?? []
  const label = connections.find((entry) => entry.harness === value)?.label ?? SHUTTLE_LABEL
  // Until the connections load, show the team as saved rather than flash an empty one.
  const shown = team && state ? effectiveTeam(team, connections, place) : team

  return (
    <DropdownMenu onOpenChange={(open) => (open ? reload() : undefined)}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Agent"
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy flex h-7 min-w-0 shrink items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50"
      >
        <span className="truncate">{value === 'shuttle' ? teamLabel(shown) : label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // The trigger sits at the right of a session composer and the left of a new-session form.
        align={side === 'top' ? 'end' : 'start'}
        side={side}
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuLabel>Run the session on</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as HarnessId)}>
          <DropdownMenuRadioItem value="shuttle">
            {SHUTTLE_LABEL}
            <span className="text-muted-foreground ml-auto text-[10px]">OpenRouter</span>
          </DropdownMenuRadioItem>
          {connections.map((connection) => {
            const status = agentStatus(connection, place)

            return (
              <DropdownMenuRadioItem key={connection.harness} value={connection.harness}>
                {connection.label}
                <span
                  className={cn(
                    'ml-auto text-[10px]',
                    status.warn ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
                  )}
                >
                  {status.text}
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        {value === 'shuttle' && shown && onTeamChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Shuttle&apos;s team</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={shown.workers}
              // Keep the menu open: a team is usually set with a few clicks.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onTeamChange(withTeamChange(shown, { workers: checked }))
              }
            >
              Shuttle workers
              <span className="text-muted-foreground ml-auto text-[10px]">OpenRouter</span>
            </DropdownMenuCheckboxItem>
            {connections.map((connection) => {
              const key = teamKey(connection.harness)

              return (
                <DropdownMenuCheckboxItem
                  key={connection.harness}
                  checked={shown[key]}
                  // A team member has no message box of its own to sign in from.
                  disabled={!canRunAt(connection, place)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    onTeamChange(withTeamChange(shown, { [key]: checked }))
                  }
                >
                  {connection.label}
                  <span className="text-muted-foreground ml-auto text-[10px]">
                    {canRunAt(connection, place)
                      ? 'Your subscription'
                      : connection.connected
                        ? `Sign in ${place === 'local' ? 'on this machine' : 'in the cloud'}`
                        : 'Not connected'}
                  </span>
                </DropdownMenuCheckboxItem>
              )
            })}
            {shown.codex && shown.claudeCode ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Roles</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={shown.preset}
                  onValueChange={(preset) =>
                    onTeamChange(withTeamChange(shown, { preset: preset as TeamPreset }))
                  }
                >
                  {PRESETS.map((preset) => (
                    <DropdownMenuRadioItem
                      key={preset}
                      value={preset}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {PRESET_LABELS[preset]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/connections">Manage connections</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The agent and team new sessions start with, for forms that create a session. `save` must
 * finish before the session is launched: a session takes the defaults on its first turn.
 */
export function useDefaultHarness(): {
  harness: HarnessId
  setHarness: (harness: HarnessId) => void
  team: Team
  setTeam: (team: Team) => void
  save: () => Promise<unknown>
} {
  const [harness, setHarness] = useState<HarnessId>('shuttle')
  const [team, setTeam] = useState<Team>(DEFAULT_TEAM)
  const [chosen, setChosen] = useState(false)

  useEffect(() => {
    if (chosen) {
      return
    }

    fetchConnections().then(
      (state) => {
        setHarness(state.defaultHarness)
        setTeam(effectiveTeam(state.defaultTeam, state.connections))
      },
      () => {},
    )
  }, [chosen])

  return {
    harness,
    setHarness: (next) => {
      setChosen(true)
      setHarness(next)
    },
    team,
    setTeam: (next) => {
      setChosen(true)
      setTeam(next)
    },
    save: () => (chosen ? setSessionDefaults({ harness, team }) : Promise.resolve()),
  }
}
