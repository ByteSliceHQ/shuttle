import type { VendorHarnessId } from '../harness'

export interface VendorHarnessInfo {
  readonly label: string
  /**
   * Files in the agent's home directory that hold its sign-in. They are saved after sign-in and
   * placed again before each turn, because the container disk does not survive a restart.
   */
  readonly credentialFiles: readonly string[]
  /** Whether Shuttle can run this agent yet. */
  readonly supported: boolean
}

const HARNESSES: Record<string, VendorHarnessInfo> = {
  codex: { label: 'Codex', credentialFiles: ['.codex/auth.json'], supported: true },
  'claude-code': {
    label: 'Claude Code',
    // Only the credentials file. `.claude.json` is mostly cached feature flags (140 KB) and
    // Claude Code runs signed in without it.
    credentialFiles: ['.claude/.credentials.json'],
    supported: true,
  },
  cursor: {
    label: 'Cursor',
    // On Linux the CLI writes the account login here after `agent login` (see Cursor auth docs /
    // Sessionboxer). `cli-config.json` under `.cursor` is settings, not the sign-in.
    credentialFiles: ['.config/cursor/auth.json'],
    supported: true,
  },
}

export function vendorHarnessInfo(harness: VendorHarnessId): VendorHarnessInfo {
  return HARNESSES[harness] ?? { label: harness, credentialFiles: [], supported: false }
}

/** The harnesses offered on the Connections page, in display order. */
export const CONNECTABLE_HARNESSES = [
  'codex',
  'claude-code',
  'cursor',
] as const satisfies VendorHarnessId[]
