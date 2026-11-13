import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  DEFAULT_TEAM,
  fetchConnections,
  setSessionDefaults,
  type ConnectionsState,
  type HarnessId,
  type Team,
  type TeamPreset,
} from '@/lib/api'

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
  const members = [team?.codex ? 'Codex' : null, team?.claudeCode ? 'Claude' : null].filter(Boolean)

  return members.length > 0 ? `${SHUTTLE_LABEL} + ${members.join(' + ')}` : SHUTTLE_LABEL
}

/** A team always has someone to do the work, and a preset needs both agents it names. */
function withTeamChange(team: Team, change: Partial<Team>): Team {
  const next = { ...team, ...change }
  const workers = next.workers || (!next.codex && !next.claudeCode)

  return { ...next, workers, preset: next.codex && next.claudeCode ? next.preset : 'none' }
}

/** Picks which agent runs the session: Shuttle's own loop, or a connected subscription. */
export function HarnessSwitcher({
  value,
  onChange,
  team,
  onTeamChange,
  disabled = false,
  side = 'top',
}: {
  value: HarnessId
  onChange: (harness: HarnessId) => void
  /** Who Shuttle's conductor may delegate to. Only applies to a Shuttle session. */
  team?: Team
  onTeamChange?: (team: Team) => void
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
        <span className="truncate">{value === 'shuttle' ? teamLabel(team) : label}</span>
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
        {value === 'shuttle' && team && onTeamChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Shuttle&apos;s team</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={team.workers}
              // Keep the menu open: a team is usually set with a few clicks.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onTeamChange(withTeamChange(team, { workers: checked }))
              }
            >
              Shuttle workers
              <span className="text-muted-foreground ml-auto text-[10px]">OpenRouter</span>
            </DropdownMenuCheckboxItem>
            {connections.map((connection) => {
              const key = connection.harness === 'codex' ? 'codex' : 'claudeCode'

              return (
                <DropdownMenuCheckboxItem
                  key={connection.harness}
                  checked={team[key] && connection.connected}
                  disabled={!connection.connected}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    onTeamChange(withTeamChange(team, { [key]: checked }))
                  }
                >
                  {connection.label}
                  <span className="text-muted-foreground ml-auto text-[10px]">
                    {connection.connected ? 'Your subscription' : 'Not connected'}
                  </span>
                </DropdownMenuCheckboxItem>
              )
            })}
            {team.codex && team.claudeCode ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Roles</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={team.preset}
                  onValueChange={(preset) =>
                    onTeamChange(withTeamChange(team, { preset: preset as TeamPreset }))
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
        setTeam(state.defaultTeam)
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
