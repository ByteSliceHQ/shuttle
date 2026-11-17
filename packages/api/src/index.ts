import { publicContract } from './auth'
import { connectionsContract } from './connections'
import { githubContract } from './github'
import { runnersContract } from './runners'
import { sandboxContract } from './sandbox'
import { playbookContract, sessionsContract } from './sessions'
import { tenantContract } from './tenant'
import { timingsContract } from './timings'
import { workspaceContract } from './workspace'

export * from './auth'
export * from './common'
export * from './connections'
export * from './github'
export * from './harness'
export * from './runners'
export * from './sandbox'
export * from './sessions'
export * from './tenant'
export * from './timings'
export * from './workspace'

/**
 * Every JSON route the Worker serves to a signed-in person, with its path, input and output.
 * The Worker implements it and validates against it.
 */
export const contract = {
  sessions: sessionsContract,
  playbook: playbookContract,
  connections: connectionsContract,
  workspace: workspaceContract,
  sandbox: sandboxContract,
  github: githubContract,
  runners: runnersContract,
  timings: timingsContract,
  tenant: tenantContract,
}

/** Everything a client can call: the signed-in routes and the public ones. */
export const clientContract = { ...contract, ...publicContract }
