import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import {
  cancelLogin,
  disconnectHarness,
  fetchConnections,
  followLogin,
  sendLoginCode,
  startLogin,
  type Connection,
  type ConnectionsState,
} from '@/lib/api'
import { errorMessage } from '@/lib/cn'

import { Button } from './ui/button'
import { Input } from './ui/input'

type SignIn =
  | { readonly step: 'starting' }
  | {
      readonly step: 'prompt'
      readonly loginId: string
      readonly url: string
      readonly code: string
      readonly needsCode: boolean
      readonly codeSent: boolean
    }
  | { readonly step: 'failed'; readonly error: string }

const POLL_MS = 1_500

/** Connect, check and remove coding agent subscriptions. */
export function ConnectionsPanel({ onChanged }: { onChanged?: (state: ConnectionsState) => void }) {
  const [state, setState] = useState<ConnectionsState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(
    () =>
      fetchConnections().then(
        (next) => {
          setState(next)
          setError(null)
          onChanged?.(next)
        },
        (cause: unknown) => setError(errorMessage(cause)),
      ),
    [onChanged],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-status-failed text-xs wrap-anywhere">{error}</p> : null}

      {state && state.mode !== 'container' ? (
        <Notice>
          Subscriptions need the container sandbox. Set{' '}
          <code className="text-foreground">SHUTTLE_WORKSPACE_MODE=container</code> in{' '}
          <code className="text-foreground">apps/worker/.dev.vars</code> and restart.
        </Notice>
      ) : null}

      {state && !state.canStore ? (
        <Notice>
          <code className="text-foreground">SHUTTLE_CREDENTIALS_KEY</code> is not set, so sign-ins
          cannot be stored. Restart with <code className="text-foreground">bun run dev</code> to
          generate one.
        </Notice>
      ) : null}

      {state?.connections.map((connection) => (
        <ConnectionRow
          key={connection.harness}
          connection={connection}
          disabled={state.mode !== 'container' || !state.canStore}
          onChanged={reload}
        />
      ))}

      {!state && !error ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Loading
        </p>
      ) : null}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground bg-muted/40 rounded-lg border px-3 py-2 text-xs leading-relaxed">
      {children}
    </p>
  )
}

function ConnectionRow({
  connection,
  disabled,
  onChanged,
}: {
  connection: Connection
  disabled: boolean
  onChanged: () => Promise<void>
}) {
  const [signIn, setSignIn] = useState<SignIn | null>(null)
  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)
  const active = useRef<string | null>(null)

  // Stop following a sign-in when the row goes away.
  useEffect(
    () => () => {
      active.current = null
    },
    [],
  )

  async function follow(loginId: string) {
    let offset = 0

    while (active.current === loginId) {
      const page = await followLogin(connection.harness, loginId, offset)

      offset = page.offset

      for (const event of page.events) {
        if (event.type === 'login_prompt') {
          setSignIn({
            step: 'prompt',
            loginId,
            url: event.url,
            code: event.code,
            needsCode: event.needsCode === true,
            codeSent: false,
          })
        }

        if (event.type === 'login_done' && !event.success) {
          active.current = null
          setSignIn({ step: 'failed', error: event.error ?? 'Sign-in did not complete.' })
          return
        }
      }

      if (page.connected) {
        active.current = null
        setSignIn(null)
        await onChanged()
        return
      }

      if (page.error) {
        active.current = null
        setSignIn({ step: 'failed', error: page.error })
        return
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  async function connect() {
    setSignIn({ step: 'starting' })
    setCodeInput('')

    try {
      const { loginId } = await startLogin(connection.harness)

      active.current = loginId
      await follow(loginId)
    } catch (cause) {
      active.current = null
      setSignIn({ step: 'failed', error: errorMessage(cause) })
    }
  }

  async function cancel() {
    const loginId = active.current

    active.current = null
    setSignIn(null)

    if (loginId) {
      await cancelLogin(connection.harness, loginId).catch(() => {})
    }
  }

  async function submitCode() {
    if (signIn?.step !== 'prompt' || !codeInput.trim()) {
      return
    }

    try {
      await sendLoginCode(connection.harness, signIn.loginId, codeInput.trim())
      setSignIn({ ...signIn, codeSent: true })
    } catch (cause) {
      setSignIn({ step: 'failed', error: errorMessage(cause) })
    }
  }

  async function disconnect() {
    await disconnectHarness(connection.harness).catch(() => {})
    await onChanged()
  }

  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">{connection.label}</p>
          <p className="text-muted-foreground text-xs">
            {connection.connected
              ? `Connected${connection.updatedAt ? ` · updated ${new Date(connection.updatedAt).toLocaleString()}` : ''}`
              : 'Not connected'}
          </p>
        </div>
        {signIn && signIn.step !== 'failed' ? (
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : connection.connected ? (
          <>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void connect()}>
              Sign in again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={disabled} onClick={() => void connect()}>
            {signIn?.step === 'failed' ? 'Try again' : 'Connect'}
          </Button>
        )}
      </div>

      {signIn?.step === 'starting' ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Starting {connection.label} sign-in. The
          first start of the sandbox can take a minute.
        </p>
      ) : null}

      {signIn?.step === 'prompt' ? (
        <div className="mt-3 flex flex-col gap-2 text-xs">
          <a
            href={signIn.url}
            target="_blank"
            rel="noreferrer"
            className="text-foreground inline-flex w-fit items-center gap-1 underline underline-offset-2"
          >
            Open the {connection.label} sign-in page <ExternalLink className="size-3" />
          </a>

          {signIn.code ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Enter this code there:</span>
              <code className="bg-muted text-foreground rounded px-2 py-1 font-mono text-sm tracking-wider">
                {signIn.code}
              </code>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copy code"
                onClick={() => {
                  void navigator.clipboard.writeText(signIn.code).then(() => setCopied(true))
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : null}

          {signIn.needsCode && !signIn.codeSent ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCode()
              }}
            >
              <Input
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value)}
                placeholder={`Paste the code ${connection.label} gives you`}
                autoComplete="off"
                className="h-8 flex-1 font-mono text-xs"
              />
              <Button size="sm" type="submit" disabled={!codeInput.trim()}>
                Submit
              </Button>
            </form>
          ) : null}

          <p className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            {signIn.needsCode && !signIn.codeSent
              ? 'Waiting for the code'
              : `Waiting for ${connection.label} to confirm`}
          </p>
        </div>
      ) : null}

      {signIn?.step === 'failed' ? (
        <p className="text-status-failed mt-3 text-xs wrap-anywhere">{signIn.error}</p>
      ) : null}
    </div>
  )
}
