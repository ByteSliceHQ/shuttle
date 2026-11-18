import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { Connection, SandboxPlace } from '@shuttle/api'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { hasText } from '../../lib/text'
import {
  type DeviceRunnerStatus,
  type ShuttleDevice,
  useApi,
  useDevice,
  useShuttleHost,
} from '../../shuttle'
import { loginOutcome, loginSettled, mergeProgress } from './login'
import { atPlace, needsSignIn, placeContext, type SignInPlace } from './places'
import { connectionsQuery } from './queries'

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

/**
 * One agent's sign-in at one place, run by the vendor CLI in that place's sandbox. Once the CLI
 * reports success, everything that shows connections reads them again and `onDone` is called.
 */
export function useSignIn(
  harness: Connection['harness'],
  place: SignInPlace,
  onDone?: () => Promise<void> | void,
) {
  const host = useShuttleHost()
  const api = useApi()
  const { client } = useShuttleHost()
  const queryClient = useQueryClient()
  const context = placeContext(host, place)

  // Goes up with every sign-in asked for and every one given up, so a sign-in that finishes
  // starting can tell whether it is still the one wanted.
  const wanted = useRef(0)

  // The prompt a code was last passed back for. The CLI asks again after a wrong code, and that
  // new prompt needs a code of its own.
  const [codeSentFor, setCodeSentFor] = useState<number | null>(null)

  const stop = useMutation(api.connections.login.cancel.mutationOptions({ context }))
  const sendCode = useMutation(api.connections.login.sendCode.mutationOptions({ context }))

  const begin = useMutation(api.connections.login.start.mutationOptions({ context }))

  const loginId = begin.data?.loginId

  const loginKey = api.connections.login.follow.queryKey({
    input: hasText(loginId) ? { harness, loginId } : skipToken,
  })

  // One entry per sign-in, holding everything it has said so far: what a single read from the
  // start would return. Each poll asks only for what came after the last one and adds it on.
  const follow = useQuery(
    api.connections.login.follow.queryOptions({
      input: hasText(loginId) ? { harness, loginId } : skipToken,
      context,
      queryFn: hasText(loginId)
        ? async ({ client: cache, signal }) => {
            const soFar = cache.getQueryData(loginKey)

            // Reading past the end of a finished sign-in would lose how it ended.
            if (soFar && loginSettled(soFar)) {
              return soFar
            }

            const page = await client.connections.login.follow(
              { harness, loginId, offset: soFar?.offset ?? 0 },
              { context, signal },
            )

            return mergeProgress(soFar, page)
          }
        : skipToken,
      // Only the poll below asks again: what is held is never out of date, only incomplete.
      staleTime: Infinity,
      refetchInterval: ({ state }) =>
        state.status === 'error' || (state.data && loginSettled(state.data)) ? false : POLL_MS,
      // Signing in happens in another tab, and the answer should be here on the way back.
      refetchIntervalInBackground: true,
    }),
  )

  const outcome = follow.data ? loginOutcome(follow.data) : null
  const connected = outcome?.status === 'connected'

  const signedIn = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: api.connections.key() })
    void onDone?.()
  })

  // The sign-in connecting is news from the sandbox, told once to everything that shows it.
  useEffect(() => {
    if (connected) {
      signedIn()
    }
  }, [connected])

  function start() {
    const turn = ++wanted.current

    sendCode.reset()
    setCodeSentFor(null)

    begin.mutateAsync({ harness }).then(
      ({ loginId: started }) => {
        // Cancelled while it was starting. Nobody is following it, so end it in the sandbox too.
        if (turn !== wanted.current) {
          stop.mutate({ harness, loginId: started })
        }
      },
      // Why it could not start is shown from the mutation itself.
      () => {},
    )
  }

  function cancel() {
    wanted.current += 1
    begin.reset()
    sendCode.reset()
    setCodeSentFor(null)

    if (hasText(loginId)) {
      // Best effort: the sign-in is no longer followed either way.
      stop.mutate({ harness, loginId })
    }
  }

  const prompt = outcome?.status === 'waiting' ? outcome.prompt : null

  function submitCode(code: string) {
    if (!hasText(loginId) || !prompt || code.trim() === '') {
      return
    }

    sendCode.mutate(
      { harness, loginId, code: code.trim() },
      { onSuccess: () => setCodeSentFor(prompt.seq) },
    )
  }

  const signIn = ((): SignInStep | null => {
    if (begin.isPending) {
      return { step: 'starting' }
    }

    if (begin.error) {
      return { step: 'failed', error: begin.error.message }
    }

    if (!hasText(loginId) || connected) {
      return null
    }

    if (outcome?.status === 'failed') {
      return { step: 'failed', error: outcome.error }
    }

    const failure = follow.error ?? sendCode.error

    if (failure) {
      return { step: 'failed', error: failure.message }
    }

    if (!prompt) {
      return { step: 'starting' }
    }

    return {
      step: 'prompt',
      loginId,
      url: prompt.url,
      code: prompt.code,
      needsCode: prompt.needsCode === true,
      codeSent: codeSentFor === prompt.seq,
    }
  })()

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

      {hasText(signIn.code) ? (
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
          <Button size="sm" type="submit" disabled={codeInput.trim() === ''}>
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

/** The viewer's connections, for something that sits in another page and must not hold it up. */
function useConnections() {
  const host = useShuttleHost()

  return useQuery({
    ...connectionsQuery(host),
    // A sign-in made elsewhere, such as in another window, shows when the page is back.
    refetchOnWindowFocus: 'always',
  })
}

/**
 * Where a new session will run: on this machine when the desktop app's sandbox is up and set
 * to take new sessions, otherwise in the cloud. Mirrors `startsOnThisMachine` in workspace.ts.
 */
export function useStartPlace(): SignInPlace {
  const app = useDevice()
  const [runner, setRunner] = useState<DeviceRunnerStatus | null>(null)
  const [wanted, setWanted] = useState(true)

  // The desktop app's runner is outside the page: it is asked once, then tells of each change.
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
  /** Called once signed in. The connections are read again without it. */
  onSignedIn?: () => Promise<void> | void
  /** Offered when the agent is signed in in the cloud and the session can move there. */
  onMoveToCloud?: () => void
}) {
  const { label } = connection
  const flow = useSignIn(connection.harness, place, onSignedIn)
  const cloudInstead = place === 'local' && connection.cloud && onMoveToCloud !== undefined

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
          <Button size="sm" variant="ghost" onClick={flow.cancel}>
            Cancel
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            {cloudInstead ? (
              <Button size="sm" variant="ghost" onClick={onMoveToCloud}>
                Move to cloud
              </Button>
            ) : null}
            <Button size="sm" onClick={flow.start}>
              {flow.signIn?.step === 'failed' ? 'Try again' : `Sign in ${atPlace(place)}`}
            </Button>
          </div>
        )}
      </div>
      <SignInProgress
        label={label}
        place={place}
        signIn={flow.signIn}
        onSubmitCode={flow.submitCode}
      />
    </div>
  )
}

export interface AgentGate {
  connection: Connection | undefined
  blocked: boolean
  reload: () => Promise<void>
  connections: readonly Connection[] | null
}

/**
 * Whether `harness` has to be signed in at `place` before a session there can use it, with the
 * agent's connection for the gate that offers it. Nothing is blocked until the connections are in.
 */
export function useAgentGate(harness: string, place: SignInPlace | null): AgentGate {
  const api = useApi()
  const queryClient = useQueryClient()
  const { data } = useConnections()
  const connection = data?.connections.find((entry) => entry.harness === harness)

  return {
    connection,
    blocked: needsSignIn(connection, place),
    // A read already under way is joined, not started over: a sign-in that has just finished
    // has asked for one, and that is the read this is after.
    reload: () =>
      queryClient.invalidateQueries({ queryKey: api.connections.key() }, { cancelRefetch: false }),
    connections: data?.connections ?? null,
  }
}

function signInPlaceOf(place: SandboxPlace, app: ShuttleDevice | null): SignInPlace | null {
  if (place.sandbox.location === 'cloud') {
    return 'cloud'
  }

  return app && place.sandbox.deviceId === app.deviceId ? 'local' : null
}

export interface SessionRunsAt {
  place: SignInPlace | null
  moveToCloud: () => Promise<void>
}

/**
 * Where a session runs, as far as sign-ins go: this machine, the cloud, or null for another of
 * the viewer's machines (or not known yet), whose sign-ins cannot be checked from here.
 */
export function useSessionRunsAt(runId: string): SessionRunsAt {
  const api = useApi()
  const device = useDevice()
  const queryClient = useQueryClient()
  const placeKey = api.sandbox.place.get.queryKey({ input: { id: runId } })

  const { data } = useQuery(
    api.sandbox.place.get.queryOptions({
      input: { id: runId },
      // The session can be moved from another window, so the answer is checked on the way back.
      refetchOnWindowFocus: 'always',
    }),
  )

  const move = useMutation(
    api.sandbox.place.move.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(placeKey, next)
      },
    }),
  )

  return {
    place: data ? signInPlaceOf(data, device) : null,
    moveToCloud: async () => {
      await move.mutateAsync({ id: runId, to: 'cloud' })
    },
  }
}
