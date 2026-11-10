import { defineModule } from '@swirls/looms/core'

import { workspaceDefinition } from './definitions'
import { workspaceTree } from './projections'
import { workspaceModule } from './scope'
import {
  archiveFolder,
  archiveSession,
  connectGithub,
  createFolder,
  disconnectGithub,
  linkRepo,
  renameFolder,
  renameSession,
  reorderFolders,
  reportActivity,
  requestSession,
  unlinkRepo,
} from './signals'
import { createWorkspaceThread } from './thread'

export function workspace() {
  return defineModule(workspaceModule, () => ({
    definitions: [workspaceDefinition],
    threads: {
      'shuttle-workspace': createWorkspaceThread(),
    },
    projections: {
      workspaceTree,
    },
    signals: {
      createFolder,
      renameFolder,
      archiveFolder,
      reorderFolders,
      connectGithub,
      disconnectGithub,
      linkRepo,
      unlinkRepo,
      requestSession,
      renameSession,
      archiveSession,
      reportActivity,
    },
  }))
}

export {
  archiveFolder,
  archiveSession,
  connectGithub,
  createFolder,
  disconnectGithub,
  linkRepo,
  renameFolder,
  renameSession,
  reorderFolders,
  reportActivity,
  requestSession,
  unlinkRepo,
  workspaceDefinition,
  workspaceTree,
}
export type {
  GithubInstallation,
  WorkspaceFolder,
  WorkspaceSession,
  WorkspaceState,
} from './thread'
export type { LinkedRepo, SessionActivity } from './scope'
