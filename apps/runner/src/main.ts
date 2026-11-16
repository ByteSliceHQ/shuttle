import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

import { DEVICE_ID } from '@shuttle/runner-protocol'

import { detectBackend } from './detect'
import { connect } from './link'
import { takeLock } from './lock'

/**
 * shuttle-runner: keeps a Shuttle sandbox on this machine.
 *
 * The desktop app starts one and hands it its settings as one line of JSON on stdin, so the
 * sign-in it carries never appears in a command line or the environment. Run by hand, it reads
 * the same settings from `SHUTTLE_URL`, `SHUTTLE_RUNNER_TOKEN` and friends. The token is the
 * machine's own (see the worker's `tenancy/devices.ts`), and says whose machine this is.
 *
 * `--remove` deletes this machine's sandbox, files and sign-ins included, and exits.
 *
 * What it prints on stdout is one JSON object per line, for whoever started it to follow.
 */

interface Settings {
  readonly url: string
  readonly token: string
  readonly deviceName?: string
  readonly image?: string
  readonly buildContext?: string
  readonly cpus?: number
  readonly memoryMb?: number
}

function report(status: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ status, ...extra })}\n`)
}

const fromStdin = process.argv.includes('--stdin')
const stdin = fromStdin ? Bun.stdin.stream().getReader() : null

/** The first line of stdin. The stream stays open: its end means whoever started us has gone. */
async function firstLine(reader: NonNullable<typeof stdin>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''

  while (!text.includes('\n')) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    text += decoder.decode(value, { stream: true })
  }

  return text.split('\n')[0] ?? ''
}

async function settings(): Promise<Settings> {
  if (stdin) {
    return JSON.parse(await firstLine(stdin)) as Settings
  }

  const { env } = process

  return {
    url: env.SHUTTLE_URL ?? 'http://127.0.0.1:8790',
    token: env.SHUTTLE_RUNNER_TOKEN ?? '',
    ...(env.SHUTTLE_DEVICE_NAME ? { deviceName: env.SHUTTLE_DEVICE_NAME } : {}),
    ...(env.SHUTTLE_SANDBOX_IMAGE ? { image: env.SHUTTLE_SANDBOX_IMAGE } : {}),
    ...(env.SHUTTLE_SANDBOX_BUILD_CONTEXT
      ? { buildContext: env.SHUTTLE_SANDBOX_BUILD_CONTEXT }
      : {}),
  }
}

const config = await settings()

// Whose machine this is. It also proves the token works before anything is started.
const self = await fetch(new URL('/runners/self', config.url), {
  headers: { authorization: `Bearer ${config.token}` },
}).catch((cause: unknown) => cause)

if (!(self instanceof Response)) {
  report('error', { message: `Could not reach Shuttle at ${config.url}: ${String(self)}` })
  process.exit(1)
}

if (!self.ok) {
  report('unauthorized', { message: 'This machine is not registered with Shuttle.' })
  process.exit(3)
}

const identity = (await self.json()) as { userId: string; orgId: string; deviceId: string }

if (!DEVICE_ID.test(identity.deviceId)) {
  report('error', { message: 'Shuttle answered with a device id this runner cannot use.' })
  process.exit(2)
}

// One sandbox per person, organization and Shuttle on this machine.
const key = createHash('sha256')
  .update([new URL(config.url).origin, identity.orgId, identity.userId].join('\n'))
  .digest('hex')
  .slice(0, 12)

const release = takeLock(key)

if (!release) {
  report('error', { message: 'Another Shuttle runner is already keeping this sandbox.' })
  process.exit(4)
}

process.on('exit', release)

const backend = await detectBackend({
  key,
  image: config.image ?? 'shuttle-sandbox:dev',
  ...(config.buildContext ? { buildContext: config.buildContext } : {}),
  ...(config.cpus || config.memoryMb
    ? {
        limits: {
          ...(config.cpus ? { cpus: config.cpus } : {}),
          ...(config.memoryMb ? { memoryMb: config.memoryMb } : {}),
        },
      }
    : {}),
  log: (line) => report('preparing', { message: line }),
}).catch((cause: unknown) => {
  report('error', { message: cause instanceof Error ? cause.message : String(cause) })
  process.exit(1)
})

if (process.argv.includes('--remove')) {
  await backend.destroy()
  report('removed', { backend: backend.info })
  process.exit(0)
}

report('preparing', { backend: backend.info })

await backend.ensure().catch((cause: unknown) => {
  report('error', { message: cause instanceof Error ? cause.message : String(cause) })
  process.exit(1)
})

const link = connect({
  url: config.url,
  token: config.token,
  backend,
  removed: () => {
    report('unauthorized', { message: 'This machine was removed from Shuttle.' })
    process.exit(3)
  },
  device: {
    id: identity.deviceId,
    name: config.deviceName ?? hostname(),
    platform: process.platform,
    arch: process.arch,
  },
  status: (status, detail) =>
    report(status, { backend: backend.info, ...(detail ? { message: detail } : {}) }),
})

let stopping = false

const stop = () => {
  if (stopping) {
    return
  }

  stopping = true
  link.close()

  // Whatever the backend does to wind down, the runner does not wait on it for long.
  void Promise.race([backend.rest?.().catch(() => {}), Bun.sleep(8000)]).then(() => process.exit(0))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// The desktop app closes stdin when it quits. The sandbox's files stay for next time.
if (stdin) {
  for (;;) {
    const { done } = await stdin.read().catch(() => ({ done: true }))

    if (done) {
      stop()

      break
    }
  }
}
