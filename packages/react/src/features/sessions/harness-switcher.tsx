import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { HarnessId, TEAM_PRESETS, TeamPreset, type Connection, type Team } from '@shuttle/api'

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
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/cn'
import { Link, useShuttleHost } from '../../shuttle'
import { signedInAt, type SignInPlace } from '../connections/places'
import { connectionsQuery } from '../connections/queries'
import { useSetSessionDefaults } from './session-queries'
import { canRunAt, DEFAULT_TEAM, effectiveTeam, withTeamChange } from './team'
import { sectionLabel } from './vendor-models'

const SHUTTLE_LABEL = 'Shuttle'

const PRESET_LABELS: Record<TeamPreset, string> = {
  none: 'Conductor decides',
  'codex-builds-claude-reviews': 'Codex builds, Claude reviews',
  'claude-builds-codex-reviews': 'Claude builds, Codex reviews',
  'claude-plans-codex-implements': 'Claude plans, Codex implements',
}

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
  const host = useShuttleHost()
  const { data: state, refetch } = useQuery(connectionsQuery(host))
  const connections = state?.connections ?? []

  // An agent with no connection of its own, such as one reached over ACP, goes by its name.
  const label =
    value === 'shuttle'
      ? SHUTTLE_LABEL
      : (connections.find((entry) => entry.harness === value)?.label ?? sectionLabel(value))

  // Until the connections load, show the team as saved rather than flash an empty one.
  const shown = team && state ? effectiveTeam(team, connections, place) : team

  return (
    // A sign-in made since the page loaded shows when the picker is opened.
    <DropdownMenu onOpenChange={(open) => (open ? void refetch() : undefined)}>
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
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const harness = HarnessId.safeParse(next)

            if (harness.success) {
              onChange(harness.data)
            }
          }}
        >
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
                  onValueChange={(next) => {
                    const preset = TeamPreset.safeParse(next)

                    if (preset.success) {
                      onTeamChange(withTeamChange(shown, { preset: preset.data }))
                    }
                  }}
                >
                  {TEAM_PRESETS.map((preset) => (
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
          <Link to={{ page: 'connections' }}>Manage connections</Link>
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
  const host = useShuttleHost()
  const { data: state } = useQuery(connectionsQuery(host))
  // What the person picked on this form. Until they pick, the form shows the saved defaults.
  const [chosen, setChosen] = useState<{ harness: HarnessId; team: Team } | null>(null)
  const { mutateAsync: saveDefaults } = useSetSessionDefaults()

  const harness = chosen?.harness ?? state?.defaultHarness ?? 'shuttle'

  const team =
    chosen?.team ?? (state ? effectiveTeam(state.defaultTeam, state.connections) : DEFAULT_TEAM)

  return {
    harness,
    setHarness: (next) => setChosen({ harness: next, team }),
    team,
    setTeam: (next) => setChosen({ harness, team: next }),
    save: () => (chosen ? saveDefaults(chosen) : Promise.resolve()),
  }
}
