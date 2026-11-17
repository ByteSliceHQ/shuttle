import type { App } from 'electron'
import type { AppUpdater } from 'electron-updater'

import type { UpdateStatus } from './channels'

/** Checks quietly; downloading and restarting always belong to the person using the app. */
export function startUpdates(
  app: Pick<App, 'isPackaged' | 'getVersion' | 'on'>,
  autoUpdater: Pick<
    AppUpdater,
    | 'autoDownload'
    | 'autoInstallOnAppQuit'
    | 'on'
    | 'checkForUpdates'
    | 'downloadUpdate'
    | 'quitAndInstall'
  >,
  changed: (status: UpdateStatus) => void,
  automatic = true,
) {
  let state: UpdateStatus = {
    status: app.isPackaged ? (automatic ? 'idle' : 'manual') : 'disabled',
    version: app.getVersion(),
  }

  let busy = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const publish = (change: Omit<UpdateStatus, 'version'>) => {
    state = { version: app.getVersion(), ...change }
    changed(state)
  }

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    publish({ status: 'available', nextVersion: info.version }),
  )

  autoUpdater.on('update-not-available', () => publish({ status: 'current' }))

  autoUpdater.on('download-progress', (progress) =>
    publish({ status: 'downloading', progress: Math.round(progress.percent) }),
  )

  autoUpdater.on('update-downloaded', (info) =>
    publish({ status: 'ready', nextVersion: info.version }),
  )

  autoUpdater.on('error', () =>
    publish({ status: 'error', message: 'Could not update Shuttle. Try again.' }),
  )

  async function check() {
    if (
      !automatic ||
      !app.isPackaged ||
      busy ||
      ['available', 'downloading', 'ready'].includes(state.status)
    ) {
      return
    }

    busy = true

    try {
      await autoUpdater.checkForUpdates()
    } catch {
      publish({ status: 'error', message: 'Could not check for updates. Try again.' })
    } finally {
      busy = false
    }
  }

  async function download() {
    if (!automatic || state.status !== 'available' || busy) {
      return
    }

    busy = true
    publish({ status: 'downloading', progress: 0 })

    try {
      await autoUpdater.downloadUpdate()
    } catch {
      publish({ status: 'error', message: 'Could not download the update. Try again.' })
    } finally {
      busy = false
    }
  }

  const initial = setTimeout(() => void check(), 15_000)
  const timer = setInterval(() => void check(), 4 * 60 * 60 * 1000)

  app.on('before-quit', () => {
    clearTimeout(initial)
    clearInterval(timer)
  })

  return {
    status: () => state,
    check,
    download,
    install: () => {
      if (automatic && state.status === 'ready') {
        autoUpdater.quitAndInstall()
      }
    },
  }
}
