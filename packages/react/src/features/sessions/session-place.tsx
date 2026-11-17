import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cloud, Laptop, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { cn } from '../../lib/cn'
import {
  type DeviceRunnerStatus,
  isolationLabel,
  useApi,
  useDevice,
  useShuttleHost,
} from '../../shuttle'
import { sessionQueries } from './session-queries'

const PROVIDERS: Record<string, string> = {
  daytona: 'Daytona',
  cloudflare: 'Cloudflare',
  memory: 'In memory',
}

const rowClass =
  'hover:bg-accent focus-visible:ring-ring/50 flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50'

function Row({
  icon,
  title,
  detail,
  current,
  busy,
  disabled,
  onSelect,
}: {
  icon: ReactNode
  title: string
  detail: string
  current: boolean
  busy: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      disabled={disabled || busy}
      onClick={current ? undefined : onSelect}
      className={rowClass}
    >
      <span className="text-muted-foreground mt-0.5 shrink-0 [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-tight font-medium">{title}</span>
        <span className="text-muted-foreground mt-0.5 block text-[11.5px] leading-snug text-pretty">
          {detail}
        </span>
      </span>
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
        {busy ? (
          <LoaderCircle className="text-muted-foreground size-3.5 animate-spin" />
        ) : current ? (
          <Check className="size-3.5" />
        ) : null}
      </span>
    </button>
  )
}

/**
 * Where a session runs, in the session's title bar: on this machine or in the cloud, with a way
 * to move it. It appears in the desktop app, and anywhere for a session that is on a machine.
 * Give it the session as its `key` so it starts fresh when the page moves to another session.
 */
export function SessionPlace({ runId, working }: { runId: string; working: boolean }) {
  const host = useShuttleHost()
  const api = useApi()
  const app = useDevice()
  const [open, setOpen] = useState(false)
  const [runner, setRunner] = useState<DeviceRunnerStatus | null>(null)
  const queryClient = useQueryClient()

  // The session page's loader starts this read without waiting on it. A move that is waiting
  // happens shortly after the turn ends, without the page being told, so it is asked after.
  const placeQuery = sessionQueries(host, runId).place
  const placeKey = placeQuery.queryKey

  const { data: place } = useQuery({
    ...placeQuery,
    refetchInterval: (query) => (query.state.data?.pending != null ? 2000 : false),
  })

  // This machine's sandbox, which only the desktop app has.
  const machineQuery = api.runners.get.queryOptions({
    input: app ? { deviceId: app.deviceId } : skipToken,
  })

  const machineKey = machineQuery.queryKey
  const { data: machine } = useQuery(machineQuery)

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: placeKey })
    void queryClient.invalidateQueries({ queryKey: machineKey })
  }, [queryClient, placeKey, machineKey])

  // Where the session is can change under the page: a turn for someone else takes it to the
  // cloud. The session's event stream says when a turn ends, and that is when to ask again.
  const wasWorking = useRef(working)

  useEffect(() => {
    if (wasWorking.current && !working) {
      refresh()
    }

    wasWorking.current = working
  }, [refresh, working])

  // The desktop app's runner is outside the page: it is asked once, then tells of each change.
  useEffect(() => {
    if (!app) {
      return
    }

    void app.runnerStatus().then(setRunner)

    return app.onRunnerStatus((status) => {
      setRunner(status)
      refresh()
    })
  }, [app, refresh])

  // While the session is working this only asks: the move happens when the turn ends.
  const move = useMutation(
    api.sandbox.place.move.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(placeKey, next),
    }),
  )

  const moving = move.isPending ? move.variables.to : null
  const error = move.error?.message

  if (!place || (!app && place.sandbox.location !== 'local' && !place.local)) {
    return null
  }

  const local = place.sandbox.location === 'local'
  const onThisMachine = local && app !== null && place.sandbox.deviceId === app.deviceId
  const elsewhere = local && !onThisMachine
  const deviceName = place.sandbox.device?.name ?? 'another machine'
  const cloudName = PROVIDERS[place.cloud.provider] ?? place.cloud.provider
  const backend = machine?.backend ?? runner?.backend

  const localDetail = !machine?.online
    ? runner?.status === 'preparing'
      ? (runner.message ?? 'Getting the sandbox ready…')
      : (runner?.message ?? 'The local sandbox is not running.')
    : `${backend?.label ?? 'Local sandbox'}, ${isolationLabel(backend?.isolation)}. Files and sign-ins stay on this machine.`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (next) {
          refresh()
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Runs ${local ? `on ${onThisMachine ? 'this machine' : deviceName}` : 'in the cloud'}. Change where this session runs`}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors duration-100 outline-none focus-visible:ring-2',
            local && place.sandbox.online === false && 'border-amber-500/40 text-amber-600',
          )}
        >
          {moving ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : local ? (
            <Laptop className="size-3" />
          ) : (
            <Cloud className="size-3" />
          )}
          <span className="max-w-32 truncate">
            {moving ? 'Moving…' : local ? (onThisMachine ? 'This machine' : deviceName) : 'Cloud'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px]">
          Where this session runs
        </p>
        <div role="menu">
          {app ? (
            <Row
              icon={<Laptop />}
              title="This machine"
              detail={localDetail}
              current={onThisMachine}
              busy={moving === 'local'}
              disabled={moving !== null || !machine?.online || !place.cloud.movable}
              onSelect={() => {
                if (app) {
                  move.mutate({ id: runId, to: 'local', deviceId: app.deviceId })
                }
              }}
            />
          ) : null}
          {elsewhere ? (
            <Row
              icon={<Laptop />}
              title={deviceName}
              detail={
                place.sandbox.online
                  ? 'Connected. Its files and sign-ins stay on that machine.'
                  : 'Not connected. The session can still move to the cloud from its last save.'
              }
              current
              busy={false}
              disabled={false}
              onSelect={() => {}}
            />
          ) : null}
          <Row
            icon={<Cloud />}
            title="Cloud"
            detail={`${cloudName}. Keeps working when this machine is closed, and teammates can join.`}
            current={!local}
            busy={moving === 'cloud'}
            disabled={
              moving !== null || !place.cloud.movable || (place.local !== null && !place.local.mine)
            }
            onSelect={() => move.mutate({ id: runId, to: 'cloud' })}
          />
        </div>
        <p
          role={error ? 'alert' : undefined}
          className={cn(
            'px-2 pt-1 pb-1.5 text-[11px] leading-snug text-pretty',
            error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {error ??
            (place.pending
              ? `Moves to ${place.pending === 'local' ? 'this machine' : 'the cloud'} when this turn ends.`
              : place.leftBehind
                ? 'This session left a machine that was not connected, from its last save. Anything changed there since is still on that machine.'
                : working
                  ? 'The session is working. A move you choose now happens when this turn ends.'
                  : place.cloud.movable
                    ? 'Moving carries the branches and uncommitted files. Installed dependencies are rebuilt where it lands.'
                    : 'Moving needs Code Storage and a cloud sandbox that runs Linux.')}
        </p>
      </PopoverContent>
    </Popover>
  )
}
