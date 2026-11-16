import type { RunnerIsolation } from '@shuttle/runner-protocol'

import type { LocalBackend, SandboxSpec } from './backend'
import { findMicrosandbox, MicrosandboxBackend } from './backends/microsandbox'
import { OciBackend } from './backends/oci'

/**
 * Picks how this machine keeps its sandbox.
 *
 * Backends are tried strongest isolation first, and the first one the machine actually has is
 * used. `SHUTTLE_LOCAL_BACKEND` names one to use instead. The built-in one comes first:
 * it ships with the app, so a machine needs nothing installed. A new backend (Apple's
 * `container`, a Seatbelt or bubblewrap process sandbox) is a `LocalBackend` and an entry in this list.
 */

interface Candidate {
  readonly id: string
  /** Null when this machine cannot use it. */
  probe(spec: SandboxSpec): Promise<LocalBackend | null>
}

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(child.stdout).text()

    return { ok: (await child.exited) === 0, out: out.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/** A container engine with a Docker-compatible command line, if it is installed and running. */
function ociEngine(bin: string, fallbackLabel: string): Candidate {
  return {
    id: bin,
    async probe(spec) {
      const info = await run([bin, 'info', '--format', '{{.ServerVersion}}\t{{.OperatingSystem}}'])

      if (!info.ok) {
        return null
      }

      const [version = '', os = ''] = info.out.split('\t')

      // Off Linux the engine's containers live in a Linux virtual machine.
      const isolation: RunnerIsolation = process.platform === 'linux' ? 'container' : 'vm'

      return new OciBackend(
        bin,
        {
          id: bin,
          label: /Docker Desktop|OrbStack|Colima|Rancher/i.test(os) ? os : fallbackLabel,
          isolation,
          ...(version ? { version } : {}),
        },
        spec,
      )
    },
  }
}

/** The sandbox runtime that ships with the app. Nothing has to be installed for it. */
const microsandbox: Candidate = {
  id: 'microsandbox',
  async probe(spec) {
    const runtime = findMicrosandbox()

    if (!runtime) {
      return null
    }

    const version = await run([runtime.msb, '--version'])

    if (!version.ok) {
      return null
    }

    const number = version.out.split(/\s+/).pop()

    return new MicrosandboxBackend(
      runtime,
      {
        id: 'microsandbox',
        label: 'Built-in sandbox',
        isolation: 'vm',
        ...(number ? { version: number } : {}),
      },
      spec,
    )
  },
}

const CANDIDATES: readonly Candidate[] = [
  microsandbox,
  ociEngine('docker', 'Docker'),
  ociEngine('podman', 'Podman'),
]

export async function detectBackend(spec: SandboxSpec): Promise<LocalBackend> {
  const wanted = process.env.SHUTTLE_LOCAL_BACKEND?.trim()
  const candidates = wanted ? CANDIDATES.filter((candidate) => candidate.id === wanted) : CANDIDATES

  for (const candidate of candidates) {
    const backend = await candidate.probe(spec)

    if (backend) {
      return backend
    }
  }

  throw new Error(
    wanted
      ? `The ${wanted} sandbox backend is not available on this machine.`
      : 'No sandbox backend is available on this machine. The built-in sandbox needs an Apple Silicon Mac; otherwise start Docker Desktop, OrbStack or Podman and try again.',
  )
}
