import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Check, Lock, UserRound } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { api } from '@/api/client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { orgMembersQuery, type OrgMember } from '@/features/auth/org-people'
import { useOrgPeople } from '@/features/auth/org-people'
import { useTenant } from '@/features/auth/tenant'
import { useFixtureMode } from '@/features/workspace/workspace-context'
import { sessionPeopleFixture } from '@/features/workspace/workspace-fixtures'
import { cn } from '@/lib/cn'
import { initials } from '@/lib/initials'
import type { SessionAccess, SessionVisibility } from '@shuttle/api'

import { sessionQueries } from './session-queries'

const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left'

const interactiveRowClass =
  'hover:bg-accent focus-visible:ring-ring/50 outline-none focus-visible:ring-2'

const MAX_AVATARS = 3

/** Counts past this read as "99+", which is as much as an avatar-sized circle holds. */
const MAX_COUNT = 99

function countLabel(count: number): string {
  return count > MAX_COUNT ? `${MAX_COUNT}+` : `+${count}`
}

function Avatar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'bg-secondary text-foreground border-background flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-[9.5px] leading-none font-medium',
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * The people in this session, as avatars in the session's title bar. Opening them shows who
 * can open the session and a way to change it. Give it the session as its `key` so it starts
 * fresh when the page moves to another session.
 */
export function SessionShare({ runId }: { runId: string }) {
  const tenant = useTenant()
  const orgPeople = useOrgPeople()
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  // Dev only: the fixture toggle swaps in worst-case people where the session's are loaded.
  const [fixtureMode] = useFixtureMode()

  const fixture = useMemo(
    () =>
      import.meta.env.DEV && fixtureMode !== 'live'
        ? sessionPeopleFixture(fixtureMode, tenant.user.id)
        : null,
    [fixtureMode, tenant.user.id],
  )

  // The session page's loader starts this read without waiting on it: the title bar shows
  // without the avatars, and they come in when it lands.
  const accessQuery = sessionQueries(runId).access
  const accessKey = accessQuery.queryKey
  const { data: access } = useQuery({ ...accessQuery, enabled: !fixture })

  // Only the open popover lists the organization.
  const members = useQuery({ ...orgMembersQuery(tenant.org.id), enabled: open })

  /** Shows the change at once and puts the old state back if the Worker refuses it. */
  const update = useMutation(
    api.sessions.access.update.mutationOptions({
      onMutate: async ({ memberIds, visibility }) => {
        await queryClient.cancelQueries({ queryKey: accessKey })

        const previous = queryClient.getQueryData(accessKey)

        if (previous) {
          queryClient.setQueryData(accessKey, {
            ...previous,
            ...(memberIds ? { memberIds } : {}),
            ...(visibility ? { visibility } : {}),
          })
        }

        return { previous }
      },
      onSuccess: (saved) => queryClient.setQueryData(accessKey, saved),
      onError: (_cause, _change, context) => {
        queryClient.setQueryData(accessKey, context?.previous)
      },
    }),
  )

  const loaded = fixture?.access ?? access

  if (!loaded) {
    return null
  }

  // A const of its own, so the functions below keep the narrowed type.
  const current: SessionAccess = loaded
  const shared = new Set(current.memberIds)
  const people = fixture?.people ?? orgPeople
  const error = update.error?.message ?? members.error?.message

  function change(next: { memberIds?: string[]; visibility?: SessionVisibility }) {
    update.mutate({ id: runId, ...next })
  }

  function toggle(userId: string) {
    change({
      memberIds: shared.has(userId)
        ? current.memberIds.filter((id) => id !== userId)
        : [...current.memberIds, userId],
    })
  }

  const isPublic = current.visibility === 'public'
  const others = (members.data ?? []).filter((member) => member.userId !== current.ownerId)
  const owner = (members.data ?? []).find((member) => member.userId === current.ownerId)

  const label = isPublic
    ? 'Everyone in the organization'
    : current.memberIds.length > 0
      ? `Shared with ${current.memberIds.length.toLocaleString()} ${current.memberIds.length === 1 ? 'person' : 'people'}`
      : 'Private'

  // You first, then the owner, then everyone the session is shared with.
  const me = tenant.user.id

  const here = [
    ...new Set([me, ...(current.ownerId ? [current.ownerId] : []), ...current.memberIds]),
  ]

  const shown = here.slice(0, MAX_AVATARS)
  const extra = here.length - shown.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label={`Sharing: ${label}`}
            className="focus-visible:ring-ring/50 ease-snappy mx-1 flex h-6 shrink-0 items-center rounded-full transition-transform duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97]"
          >
            {shown.map((userId, index) => (
              // Where the title bar is narrow only the first person shows, with a count.
              <Avatar key={userId} className={index > 0 ? '-ml-1.5 hidden @sm:flex' : undefined}>
                {initials(people.get(userId)) || <UserRound className="size-3" />}
              </Avatar>
            ))}
            {extra > 0 ? (
              <Avatar className="text-muted-foreground -ml-1.5 hidden text-[9px] tabular-nums @sm:flex">
                {countLabel(extra)}
              </Avatar>
            ) : null}
            {here.length > 1 ? (
              <Avatar className="text-muted-foreground -ml-1.5 text-[9px] tabular-nums @sm:hidden">
                {countLabel(here.length - 1)}
              </Avatar>
            ) : null}
            {isPublic ? (
              <Avatar className="text-muted-foreground -ml-1.5 hidden @sm:flex">
                <Building2 className="size-3" />
              </Avatar>
            ) : null}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-2">
        <h2 className="px-2 pt-1 pb-2 text-[13px] font-medium">Who can open this session</h2>

        {current.ownerId === null ? (
          <p className="text-muted-foreground px-2 pb-2 text-[12px] leading-relaxed text-pretty">
            Shuttle started this session, so everyone in the organization can open it.
          </p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Visibility" className="flex flex-col gap-px">
              <VisibilityOption
                icon={<Lock />}
                title="Private"
                detail="Only you and the people you add. Nobody else knows it exists."
                selected={!isPublic}
                onSelect={
                  current.canShare && isPublic ? () => change({ visibility: 'private' }) : undefined
                }
              />
              <VisibilityOption
                icon={<Building2 />}
                title="Everyone in the organization"
                detail="Every member can find it, read it and send messages."
                selected={isPublic}
                onSelect={
                  current.canShare && !isPublic ? () => change({ visibility: 'public' }) : undefined
                }
              />
            </div>

            {isPublic ? null : (
              <>
                <h3 className="text-muted-foreground px-2 pt-3 pb-1 text-[11px] font-medium">
                  {current.canShare ? 'Add people' : 'People'}
                </h3>
                <ul className="flex max-h-56 flex-col gap-px overflow-y-auto">
                  {owner ? (
                    <MemberRow member={owner} you={owner.userId === tenant.user.id} note="Owner" />
                  ) : null}
                  {others
                    .filter((member) => current.canShare || shared.has(member.userId))
                    .map((member) => (
                      <MemberRow
                        key={member.userId}
                        member={member}
                        you={member.userId === tenant.user.id}
                        checked={shared.has(member.userId)}
                        onToggle={current.canShare ? () => toggle(member.userId) : undefined}
                      />
                    ))}
                  {current.canShare && members.data && others.length === 0 ? (
                    <li className="text-muted-foreground px-2 py-1.5 text-[12px] leading-relaxed">
                      Nobody else is in this organization yet. Invite people from the account menu.
                    </li>
                  ) : null}
                </ul>
              </>
            )}

            {current.canShare ? null : (
              <p className="text-muted-foreground px-2 pt-2 text-[11.5px]">
                Only the session's owner can change this.
              </p>
            )}
          </>
        )}

        {error ? (
          <p role="alert" className="text-destructive px-2 pt-2 text-[12px]">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function VisibilityOption({
  icon,
  title,
  detail,
  selected,
  onSelect,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  selected: boolean
  /** Absent when this option cannot be chosen: it is already selected, or the viewer may not. */
  onSelect?: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!onSelect && !selected}
      className={cn(
        rowClass,
        'items-start disabled:opacity-50',
        onSelect ? interactiveRowClass : 'cursor-default outline-none',
        selected && 'bg-accent/60',
      )}
      onClick={onSelect}
    >
      <span className="text-muted-foreground mt-0.5 [&_svg]:size-3.5">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-medium">{title}</span>
        <span className="text-muted-foreground text-[11.5px] leading-snug text-pretty">
          {detail}
        </span>
      </span>
      {selected ? <Check className="text-brand mt-0.5 size-3.5 shrink-0" /> : null}
    </button>
  )
}

function MemberRow({
  member,
  you,
  note,
  checked,
  onToggle,
}: {
  member: OrgMember
  you: boolean
  note?: string
  checked?: boolean
  onToggle?: () => void
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px]">
          {member.name || member.email}
          {you ? <span className="text-muted-foreground"> (you)</span> : null}
        </span>
        <span className="text-muted-foreground truncate text-[11px]">{member.email}</span>
      </span>
      {note ? <span className="text-muted-foreground text-[11px]">{note}</span> : null}
      {checked ? <Check className="text-brand size-3.5 shrink-0" /> : null}
    </>
  )

  return (
    <li>
      {onToggle ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked ?? false}
          className={cn(rowClass, interactiveRowClass)}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  )
}
