import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { CHANNELS, type DesktopInfo, type RunnerStatus, type UpdateStatus } from './channels'

/**
 * The only part of the app the page can reach. It is how the session UI knows it is running in
 * the desktop app, which machine this is, and whether its sandbox is up. See `lib/desktop.ts`
 * in the web app for the other side.
 */
const info = ipcRenderer.sendSync(CHANNELS.info) as DesktopInfo

contextBridge.exposeInMainWorld('shuttleDesktop', {
  ...info,
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(CHANNELS.updateStatus),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(CHANNELS.checkForUpdates),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(CHANNELS.downloadUpdate),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(CHANNELS.installUpdate),
  onUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus) => listener(status)
    ipcRenderer.on(CHANNELS.updateStatusChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.updateStatusChanged, handler)
  },
  runnerStatus: (): Promise<RunnerStatus> => ipcRenderer.invoke(CHANNELS.runnerStatus),
  startsLocally: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.startsLocally),
  onRunnerStatus: (listener: (status: RunnerStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: RunnerStatus) => listener(status)

    ipcRenderer.on(CHANNELS.runnerStatusChanged, handler)

    return () => ipcRenderer.removeListener(CHANNELS.runnerStatusChanged, handler)
  },
})
