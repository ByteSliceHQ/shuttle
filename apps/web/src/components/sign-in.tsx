import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  cancelLogin,
  fetchConnections,
  followLogin,
  sendLoginCode,
  signedInAt,
  startLogin,
  type Connection,
  type ConnectionsState,
  type SignInPlace,
} from '@/lib/api'
import { errorMessage } from '@/lib/cn'
import { desktop, type DesktopRunnerStatus } from '@/lib/desktop'
import { fetchSandboxPlace, moveSession } from '@/lib/sandbox'

import { Button } from './ui/button'
import { Input } from './ui/input'

export type SignInStep =
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

/** The words for a place, as in "signed in on this machine". */
export function placeName(place: SignInPlace): string {
  return place === 'local' ? 'this machine' : 'the cloud'
}

/** "on this machine" or "in the cloud". */
export function atPlace(place: SignInPlace): string {
  return place === 'local' ? 'on this machine' : 'in the cloud'
}

/**
 * One agent's sign-in at one place, run by the vendor CLI in that place's sandbox. `onDone` is
 * called once the CLI reports success.
 */
export function useSignIn(
  harness: Connection['harness'],
  place: SignInPlace,
  onDone: () => Promise<unknown> | void,
) {
  const [signIn, setSignIn] = useState<SignInStep | null>(null)
  const active = useRef<string | null>(null)

  // Stop following a sign-in when the component goes away.
  useEffect(
    () => () => {
      active.current = null
    },
    [],
  )

  async function follow(loginId: string) {
    let offset = 0

    while (active.current === loginId) {
      const page = await followLogin(harness, loginId, offset, place)

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
        await onDone()
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

  async function start() {
    setSignIn({ step: 'starting' })

    try {
      const { loginId } = await startLogin(harness, place)

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
      await cancelLogin(harness, loginId, place).catch(() => {})
    }
  }

  async function submitCode(code: string) {
    if (signIn?.step !== 'prompt' || !code.trim()) {
      return
    }

    try {
      await sendLoginCode(harness, signIn.loginId, code.trim(), place)
      setSignIn({ ...signIn, codeSent: true })
    } catch (cause) {
      setSignIn({ step: 'failed', error: errorMessage(cause) })
    }
  }

  return {
    signIn,
    /** True from the moment sign-in starts until it succeeds, fails or is cancelled. */
    busy: signIn !== null && signIn.step !== 'failed',
    start,
    cancel,
    submitCode,
  }
}

/** What a sign-in under way needs from the person: the page to open, a code, or patience. */
export function SignInProgress({
  label,
  place,
  signIn,
  onSubmitCode,
}: {
  label: string
  place: SignInPlace
  signIn: SignInStep | null
  onSubmitCode: (code: string) => void
}) {
  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)

  if (!signIn) {
    return null
  }

  if (signIn.step === 'starting') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        Starting {label} sign-in {atPlace(place)}.
        {place === 'cloud' ? ' The first start of the sandbox can take a minute.' : ''}
      </p>
    )
  }

  if (signIn.step === 'failed') {
    return <p className="text-status-failed text-xs wrap-anywhere">{signIn.error}</p>
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      <a
        href={signIn.url}
        target="_blank"
        rel="noreferrer"
        className="text-foreground inline-flex w-fit items-center gap-1 underline underline-offset-2"
      >
        Open the {label} sign-in page <ExternalLink className="size-3" />
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
            onSubmitCode(codeInput)
          }}
        >
          <Input
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value)}
            placeholder={`Paste the code ${label} gives you`}
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
          : `Waiting for ${label} to confirm`}
      </p>
    </div>
  )
}

/** The viewer's connections, reloaded on demand. Null until they first load. */
export function useConnections(): {
  state: ConnectionsState | null
  reload: () => Promise<void>
} {
  const [state, setState] = useState<ConnectionsState | null>(null)

  const reload = useCallback(
    () =>
      fetchConnections().then(
        (next) => setState(next),
        () => {},
      ),
    [],
  )

  useEffect(() => {
    void reload()

    // A sign-in made elsewhere, such as on the Connections page, shows when the page is back.
    const onFocus = () => void reload()

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  return { state, reload }
}

/**
 * Where a new session will run: on this machine when the desktop app's sandbox is up and set
 * to take new sessions, otherwise in the cloud. Mirrors `startsOnThisMachine` in workspace.ts.
 */
export function useStartPlace(): SignInPlace {
  const app = desktop()
  const [runner, setRunner] = useState<DesktopRunnerStatus | null>(null)
  const [wanted, setWanted] = useState(true)

  useEffect(() => {
    if (!app) {
      return
    }

    void app.runnerStatus().then(setRunner, () => {})
    void app.startsLocally().then(setWanted, () => {})

    return app.onRunnerStatus((status) => {
      setRunner(status)
      void app.startsLocally().then(setWanted, () => {})
    })
  }, [app])

  return app && wanted && runner?.status === 'online' ? 'local' : 'cloud'
}

/**
 * Whether an agent can run at `place`. False only when it is known not to be signed in there,
 * so a place that cannot be checked from here never blocks anyone.
 */
export function needsSignIn(
  connection: Connection | undefined,
  place: SignInPlace | null,
): connection is Connection {
  return Boolean(connection && place && signedInAt(connection, place) === false)
}

/**
 * Shown in a message box whose agent is not signed in where the session runs. Signs in right
 * there, or offers the other place where the agent is already signed in.
 */
export function SignInGate({
  connection,
  place,
  onSignedIn,
  onMoveToCloud,
  upcoming = false,
}: {
  connection: Connection
  place: SignInPlace
  /** For a session not started yet, which will run at `place`. */
  upcoming?: boolean
  onSignedIn: () => Promise<unknown> | void
  /** Offered when the agent is signed in in the cloud and the session can move there. */
  onMoveToCloud?: () => void
}) {
  const { label } = connection
  const flow = useSignIn(connection.harness, place, onSignedIn)
  const cloudInstead = place === 'local' && connection.cloud && onMoveToCloud

  return (
    <div className="bg-muted/40 mx-1 mt-1 mb-1.5 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-foreground flex min-w-0 flex-1 items-start gap-2 text-xs leading-relaxed text-pretty">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {label} is not signed in {atPlace(place)}, where this session{' '}
            {upcoming ? 'will run' : 'runs'}
            {connection.connected
              ? ` (it is signed in ${atPlace(place === 'local' ? 'cloud' : 'local')})`
              : ''}
            .
          </span>
        </p>
        {flow.busy ? (
          <Button size="sm" variant="ghost" onClick={() => void flow.cancel()}>
            Cancel
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            {cloudInstead ? (
              <Button size="sm" variant="ghost" onClick={onMoveToCloud}>
                Move to cloud
              </Button>
            ) : null}
            <Button size="sm" onClick={() => void flow.start()}>
              {flow.signIn?.step === 'failed' ? 'Try again' : `Sign in ${atPlace(place)}`}
            </Button>
          </div>
        )}
      </div>
      <SignInProgress
        label={label}
        place={place}
        signIn={flow.signIn}
        onSubmitCode={(code) => void flow.submitCode(code)}
      />
    </div>
  )
}

/**
 * Whether `harness` has to be signed in at `place` before a session there can use it, with the
 * agent's connection for the gate that offers it.
 */
export function useAgentGate(
  harness: string,
  place: SignInPlace | null,
): {
  connection: Connection | undefined
  blocked: boolean
  reload: () => Promise<void>
  connections: readonly Connection[] | null
} {
  const { state, reload } = useConnections()
  const connection = state?.connections.find((entry) => entry.harness === harness)

  return {
    connection,
    blocked: needsSignIn(connection, place),
    reload,
    connections: state?.connections ?? null,
  }
}

/** Fired on `window` when a session moves, with its run id, so views of it can catch up. */
export const SESSION_MOVED_EVENT = 'shuttle:session-moved'

/**
 * Where a session runs, as far as sign-ins go: this machine, the cloud, or null for another of
 * the viewer's machines (or not known yet), whose sign-ins cannot be checked from here.
 */
export function useSessionRunsAt(runId: string): {
  place: SignInPlace | null
  moveToCloud: () => Promise<void>
} {
  const [place, setPlace] = useState<SignInPlace | null>(null)

  const refresh = useCallback(() => {
    fetchSandboxPlace(runId).then(
      (next) => {
        const app = desktop()

        setPlace(
          next.sandbox.location === 'cloud'
            ? 'cloud'
            : app && next.sandbox.deviceId === app.deviceId
              ? 'local'
              : null,
        )
      },
      () => {},
    )
  }, [runId])

  useEffect(() => {
    refresh()

    const onMoved = (event: Event) => {
      if ((event as CustomEvent<string>).detail === runId) {
        refresh()
      }
    }

    window.addEventListener(SESSION_MOVED_EVENT, onMoved)
    window.addEventListener('focus', refresh)

    return () => {
      window.removeEventListener(SESSION_MOVED_EVENT, onMoved)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh, runId])

  return {
    place,
    moveToCloud: () =>
      moveSession(runId, { to: 'cloud' }).then(() => {
        window.dispatchEvent(new CustomEvent(SESSION_MOVED_EVENT, { detail: runId }))
      }),
  }
}
