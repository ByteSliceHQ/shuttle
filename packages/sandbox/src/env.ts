import type { GitEnv } from '@shuttle/git/env'

/** What the sandbox code reads from a host's configuration. */
export interface SandboxEnv extends GitEnv {
  /**
   * The provider the deployment's own sandboxes run on: `memory` (default), `container`
   * (Cloudflare) or `daytona`. A sandbox on a person's machine is local whatever this says.
   */
  readonly SHUTTLE_WORKSPACE_MODE?: string
  readonly DAYTONA_API_KEY?: string
  readonly DAYTONA_API_URL?: string
  readonly DAYTONA_TARGET?: string
  /** Daytona snapshot built from `packages/sandbox/Dockerfile`: the agent CLIs and the bridge. */
  readonly DAYTONA_SNAPSHOT?: string
  readonly SHUTTLE_PREVIEW_HOST?: string
}
