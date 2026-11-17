import { Check, ChevronsUpDown, Copy, LogOut, Plus, UserPlus } from 'lucide-react'
import { useState, type SubmitEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { forgetEventCache } from '@/features/events/event-cache'
import { useTenant } from '@/shuttle'

import { authClient } from './auth-client'
import { invitationLink, rememberTenant } from './tenant'

/** Everything on the page belongs to one organization, so changing it starts the app again. */
function restart() {
  window.location.assign('/')
}

/** The sidebar's account button: who is signed in, which organization, and how to change both. */
export function AccountMenu() {
  const tenant = useTenant()
  const organizations = authClient.useListOrganizations()
  const [dialog, setDialog] = useState<'create' | 'invite' | null>(null)

  const current = organizations.data?.find((organization) => organization.id === tenant.org.id)
  const canInvite = tenant.org.role !== 'member'

  async function switchTo(organizationId: string) {
    if (organizationId === tenant.org.id) {
      return
    }

    await authClient.organization.setActive({ organizationId })
    // The app opens as whoever it remembers, and that is now the wrong organization.
    rememberTenant(null)
    restart()
  }

  async function signOut() {
    await authClient.signOut()
    // Sessions kept on this device for quick opening go with the sign-in.
    forgetEventCache(tenant.user.id)
    rememberTenant(null)
    restart()
  }

  return (
    <div className="shrink-0 border-t p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 w-full justify-start gap-2 px-2 text-left"
            aria-label="Account and organization"
          >
            <span className="bg-accent text-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium uppercase">
              {Array.from(tenant.user.name || tenant.user.email)[0] ?? '?'}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground truncate text-[12.5px] leading-tight font-medium">
                {tenant.user.name || tenant.user.email}
              </span>
              <span className="text-muted-foreground truncate text-[11px] leading-tight">
                {current?.name ?? 'Organization'}
              </span>
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-60">
          <DropdownMenuLabel className="truncate">{tenant.user.email}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={tenant.org.id}
            onValueChange={(organizationId) => void switchTo(organizationId)}
          >
            {(organizations.data ?? []).map((organization) => (
              <DropdownMenuRadioItem key={organization.id} value={organization.id}>
                <span className="truncate">{organization.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog('create')}>
            <Plus />
            New organization
          </DropdownMenuItem>
          {canInvite ? (
            <DropdownMenuItem onSelect={() => setDialog('invite')}>
              <UserPlus />
              Invite people
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrganizationDialog open={dialog === 'create'} onClose={() => setDialog(null)} />
      <InviteDialog
        open={dialog === 'invite'}
        organizationName={current?.name ?? 'this organization'}
        onClose={() => setDialog(null)}
      />
    </div>
  )
}

function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 32)

  // Slugs are unique across Shuttle; the suffix keeps two "Acme"s from colliding.
  return `${base || 'org'}-${crypto.randomUUID().slice(0, 8)}`
}

function CreateOrganizationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const created = await authClient.organization.create({
      name: name.trim(),
      slug: slugFor(name),
    })

    if (created.error) {
      setBusy(false)
      setError(created.error.message ?? 'The organization could not be created.')
      return
    }

    await authClient.organization.setActive({ organizationId: created.data.id })
    restart()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>
              An organization has its own folders, sessions and GitHub connection. You can invite
              people to it afterwards.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Organization name"
            aria-label="Organization name"
            required
            autoFocus
          />
          {error ? (
            <p role="alert" className="text-destructive text-[12.5px]">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function InviteDialog({
  open,
  organizationName,
  onClose,
}: {
  open: boolean
  organizationName: string
  onClose: () => void
}) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function close() {
    setEmail('')
    setError(null)
    setLink(null)
    setCopied(false)
    onClose()
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

    const invited = await authClient.organization.inviteMember({
      email: email.trim(),
      role: 'member',
    })

    setBusy(false)

    if (invited.error) {
      setError(invited.error.message ?? 'The invitation could not be created.')
      return
    }

    setLink(invitationLink(window.location.origin, invited.data.id))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="max-w-sm">
        {link ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Send them this link</DialogTitle>
              <DialogDescription>
                Shuttle does not send email. The link works for {email.trim()} only, after they sign
                in or create an account with that address.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={link} aria-label="Invitation link" className="font-mono" />
              <Button
                variant="outline"
                size="icon"
                className="size-9"
                aria-label="Copy invitation link"
                onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <DialogHeader>
              <DialogTitle>Invite to {organizationName}</DialogTitle>
              <DialogDescription>
                Members can see the organization's folders and start sessions. They see another
                person's session only once it is shared with them.
              </DialogDescription>
            </DialogHeader>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              aria-label="Email address"
              required
              autoFocus
            />
            {error ? (
              <p role="alert" className="text-destructive text-[12.5px]">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || email.trim() === ''}>
                Create invitation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
