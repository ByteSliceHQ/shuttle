import { Daytona, DaytonaConflictError, DaytonaNotFoundError, type Sandbox } from '@daytona/sdk'

import type { ShuttleEnv } from '../env'
import { shellQuote } from './exec-argv'

/**
 * Daytona sandboxes: where coding sessions run in the cloud. A sandbox keeps its disk when it
 * stops and when it is archived, so whatever a person signed in to there is still signed in when
 * it starts again, without Shuttle ever reading it.
 */

/** Minutes without activity before Daytona stops a sandbox. Its disk is kept. */
const AUTO_STOP_MINUTES = 30

/** Seconds to wait for a stopped or archived sandbox to start. */
const START_TIMEOUT_SECONDS = 180

/**
 * Sets a short prompt before each command, in bash. The default one is the sandbox's id and the
 * full path of a session's worktree, which together fill two lines of a side panel. This shows
 * the path inside the session (`demo/src`), or the directory as usual anywhere else.
 */
const SHORT_PROMPT = [
  String.raw`__d=\${PWD#/workspace/.wt/*/};`,
  String.raw`case "$PWD" in /workspace/.wt/*/*) ;; /workspace/.wt/*) __d=. ;; *) __d=\${PWD/#$HOME/\~} ;; esac;`,
  String.raw`PS1="\[\e[34m\]\${__d}\[\e[0m\] \$ "`,
]
  .join(' ')
  .replaceAll(String.raw`\${`, '${')

/** Where a terminal opens when the directory asked for is not in this sandbox. */
const TERMINAL_HOME = '/workspace'

/** Makes /workspace exist and belong to the sandbox's user. Does nothing once that is true. */
const PREPARE_WORKSPACE =
  'test -w /workspace || { sudo -n mkdir -p /workspace && sudo -n chown "$(id -u):$(id -g)" /workspace; } 2>&1'

type DaytonaEnv = Pick<
  ShuttleEnv,
  'DAYTONA_API_KEY' | 'DAYTONA_API_URL' | 'DAYTONA_TARGET' | 'DAYTONA_SNAPSHOT'
>

export function daytonaConfigured(env: DaytonaEnv): boolean {
  return Boolean(env.DAYTONA_API_KEY?.trim())
}

/** A name Daytona accepts for the sandbox behind a Shuttle sandbox object. */
export function daytonaSandboxName(shuttleName: string): string {
  return `shuttle-${shuttleName.replaceAll(/[^A-Za-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '')}`
}

/** The part of a Daytona sandbox that starting it uses. The SDK's `Sandbox` satisfies it. */
export interface StartableSandbox {
  readonly state?: string
  refreshData(): Promise<void>
  start(timeout?: number): Promise<void>
  waitUntilStarted(timeout?: number): Promise<void>
  waitUntilStopped(timeout?: number): Promise<void>
}

/** States Daytona passes through on its own way to `started`. */
const STARTING_STATES = new Set(['creating', 'starting', 'restoring', 'pulling_snapshot'])

/**
 * What Daytona answers, to a command or a preview request, when the sandbox is not running. The
 * request never reached the sandbox, so it is safe to send again once the sandbox is up.
 */
const NOT_RUNNING = 'Is the Sandbox started?'

/** Whether `failure` (an error, or the text of a preview response) says the sandbox is not running. */
export function sandboxNotRunning(failure: unknown): boolean {
  if (failure instanceof DaytonaConflictError) {
    return true
  }

  const text =
    failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : ''

  return text.includes(NOT_RUNNING)
}

/** The largest body worth reading to see whether an error is Daytona's own. */
const OWN_ERROR_MAX_BYTES = 4096

/**
 * Whether a preview response is Daytona's own error rather than an answer from the sandbox, as
 * when nothing listens on the port. Daytona signs these with a `source` naming itself.
 */
export async function isDaytonaOwnError(response: Response): Promise<boolean> {
  if (response.status < 400 || !response.headers.get('content-type')?.includes('json')) {
    return false
  }

  if (Number(response.headers.get('content-length') ?? 0) > OWN_ERROR_MAX_BYTES) {
    return false
  }

  try {
    const body = (await response.clone().json()) as { source?: unknown } | null

    return typeof body?.source === 'string' && body.source.startsWith('DAYTONA')
  } catch {
    return false
  }
}

/**
 * Brings a sandbox to `started` from whatever state it is in.
 *
 * Daytona refuses to start a sandbox that is already changing state: one that is still stopping
 * after going idle, or one that another request began starting a moment ago. Those are waited
 * out rather than reported, so a tab that touches a sleeping sandbox wakes it.
 */
export async function ensureStarted(
  sandbox: StartableSandbox,
  options: { readonly timeoutSeconds?: number; readonly pauseMs?: number } = {},
): Promise<void> {
  const timeoutSeconds = options.timeoutSeconds ?? START_TIMEOUT_SECONDS
  const deadline = Date.now() + timeoutSeconds * 1000

  for (;;) {
    try {
      // The state held locally may be minutes old.
      await sandbox.refreshData()

      const state = sandbox.state ?? ''

      if (state === 'started') {
        return
      }

      if (state === 'stopping') {
        await sandbox.waitUntilStopped(timeoutSeconds)
      } else if (STARTING_STATES.has(state)) {
        await sandbox.waitUntilStarted(timeoutSeconds)

        return
      }

      await sandbox.start(timeoutSeconds)

      return
    } catch (cause) {
      // Someone else changed its state between the check and the request. Look again.
      if (!(cause instanceof DaytonaConflictError) || Date.now() >= deadline) {
        throw cause
      }

      await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 1000))
    }
  }
}

function daytonaClient(env: DaytonaEnv): Daytona {
  const apiKey = env.DAYTONA_API_KEY?.trim()

  if (!apiKey) {
    throw new Error('DAYTONA_API_KEY is not set; Daytona sandboxes are unavailable')
  }

  return new Daytona({
    apiKey,
    ...(env.DAYTONA_API_URL?.trim() ? { apiUrl: env.DAYTONA_API_URL.trim() } : {}),
    ...(env.DAYTONA_TARGET?.trim() ? { target: env.DAYTONA_TARGET.trim() } : {}),
  })
}

/**
 * The running Daytona sandbox for `shuttleName`, created the first time it is asked for and
 * started if it had stopped.
 */
export async function connectDaytonaSandbox(
  env: DaytonaEnv,
  shuttleName: string,
): Promise<Sandbox> {
  const daytona = daytonaClient(env)

  const name = daytonaSandboxName(shuttleName)
  let sandbox: Sandbox

  try {
    sandbox = await daytona.get(name)
  } catch (cause) {
    if (!(cause instanceof DaytonaNotFoundError)) {
      throw cause
    }

    sandbox = await daytona.create({
      name,
      labels: { app: 'shuttle', sandbox: shuttleName.slice(0, 63) },
      autoStopInterval: AUTO_STOP_MINUTES,
      // The image with the agent CLIs and the bridge. Without one, Daytona's default image is
      // used, which can run commands and edit files but not vendor agents.
      ...(env.DAYTONA_SNAPSHOT?.trim() ? { snapshot: env.DAYTONA_SNAPSHOT.trim() } : {}),
    })
  }

  await ensureStarted(sandbox)

  // Shuttle keeps repositories and worktrees under /workspace. Daytona's default image has no
  // such directory and runs as an ordinary user, so it is made here and handed to that user.
  const prepared = await sandbox.process.executeCommand(PREPARE_WORKSPACE)

  if (prepared.exitCode !== 0) {
    throw new Error(`could not prepare /workspace in the sandbox: ${prepared.result.trim()}`)
  }

  return sandbox
}

/**
 * The state of the Daytona sandbox for `shuttleName`, without starting or creating it. Null when
 * there is none yet.
 */
export async function peekDaytonaSandbox(
  env: DaytonaEnv,
  shuttleName: string,
): Promise<string | null> {
  try {
    const sandbox = await daytonaClient(env).get(daytonaSandboxName(shuttleName))

    return sandbox.state ?? 'unknown'
  } catch (cause) {
    if (cause instanceof DaytonaNotFoundError) {
      return null
    }

    throw cause
  }
}

/** Upgrades a request into a terminal in the sandbox. */
export async function openDaytonaTerminal(request: Request, sandbox: Sandbox): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 })
  }

  const url = new URL(request.url)

  const size = (name: string, fallback: number) => {
    const value = Number(url.searchParams.get(name) ?? fallback)

    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()

  const closeSocket = (reason: string) => {
    try {
      server.close(1000, reason)
    } catch {
      // Already closed.
    }
  }

  const asked = url.searchParams.get('cwd') || TERMINAL_HOME

  // A session's files are only in the sandbox it is working in, which may not be this one.
  const there = await sandbox.process.executeCommand(`test -d ${shellQuote(asked)}`)

  const pty = await sandbox.process.createPty({
    id: `shuttle-${crypto.randomUUID()}`,
    cwd: there.exitCode === 0 ? asked : TERMINAL_HOME,
    // Without these the shell assumes a terminal with no colour and no cursor movement.
    envs: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
      PROMPT_COMMAND: SHORT_PROMPT,
    },
    cols: size('cols', 80),
    rows: size('rows', 24),
    onData: (data) => {
      try {
        server.send(data)
      } catch {
        // The browser went away; the close handler ends the terminal.
      }
    },
  })

  await pty.waitForConnection()

  void pty.wait().then(
    () => closeSocket('process exited'),
    () => closeSocket('terminal failed'),
  )

  server.addEventListener('message', (event) => {
    const { data } = event

    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown }

        if (
          message.type === 'resize' &&
          typeof message.cols === 'number' &&
          typeof message.rows === 'number'
        ) {
          void pty.resize(message.cols, message.rows).catch(() => {})
          return
        }
      } catch {
        // Not a control message: it is typed input.
      }

      void pty.sendInput(data).catch(() => {})
      return
    }

    void pty.sendInput(new Uint8Array(data)).catch(() => {})
  })

  server.addEventListener('close', () => {
    void pty.kill().catch(() => {})
  })

  return new Response(null, { status: 101, webSocket: client })
}

/** Forwards a preview request to a port in the sandbox. */
export async function proxyDaytonaPreview(
  request: Request,
  sandbox: Sandbox,
  port: number,
  /** The body to send, when it is not the request's own (which can be read only once). */
  body: ReadableStream | null = request.body,
): Promise<Response> {
  const preview = await sandbox.getPreviewLink(port)
  const incoming = new URL(request.url)
  const target = new URL(preview.url)

  target.pathname = incoming.pathname
  target.search = incoming.search

  const headers = new Headers(request.headers)

  headers.delete('host')
  // Daytona checks this instead of a sign-in, so the preview never needs a Daytona account.
  headers.set('x-daytona-preview-token', preview.token)
  // Daytona shows a warning page to browsers on first visit; this asks it not to.
  headers.set('x-daytona-skip-preview-warning', 'true')

  return fetch(new Request(target, { method: request.method, headers, body }))
}
