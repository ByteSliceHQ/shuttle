import { defineModule } from '@swirls/looms/core'

import { workspaceDefinition } from './definitions'
import { sessionTabs, workspaceTree } from './projections'
import { workspaceModule } from './scope'
import {
  archiveFolder,
  archiveSession,
  closeTab,
  connectGithub,
  createFolder,
  disconnectGithub,
  linkRepo,
  openTab,
  renameFolder,
  renameSession,
  reorderFolders,
  reorderTabs,
  reportActivity,
  requestSession,
  retargetTab,
  setFolderAutoReview,
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
      sessionTabs,
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
      openTab,
      closeTab,
      reorderTabs,
      retargetTab,
      setFolderAutoReview,
    },
  }))
}

export {
  archiveFolder,
  archiveSession,
  closeTab,
  connectGithub,
  createFolder,
  disconnectGithub,
  linkRepo,
  openTab,
  renameFolder,
  renameSession,
  reorderFolders,
  reorderTabs,
  reportActivity,
  requestSession,
  retargetTab,
  sessionTabs,
  setFolderAutoReview,
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
export type { LinkedRepo, SessionActivity, ArtifactTabKind } from './scope'
export type { ArtifactTab, SessionTabSet, SessionTabsState } from './projections'
