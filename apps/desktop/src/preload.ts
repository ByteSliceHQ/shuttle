import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { CHANNELS, type DesktopInfo, type RunnerStatus } from './channels'

/**
 * The only part of the app the page can reach. It is how the session UI knows it is running in
 * the desktop app, which machine this is, and whether its sandbox is up. See `lib/desktop.ts`
 * in the web app for the other side.
 */
const info = ipcRenderer.sendSync(CHANNELS.info) as DesktopInfo

contextBridge.exposeInMainWorld('shuttleDesktop', {
  ...info,
  runnerStatus: (): Promise<RunnerStatus> => ipcRenderer.invoke(CHANNELS.runnerStatus),
  startsLocally: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.startsLocally),
  onRunnerStatus: (listener: (status: RunnerStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: RunnerStatus) => listener(status)

    ipcRenderer.on(CHANNELS.runnerStatusChanged, handler)

    return () => ipcRenderer.removeListener(CHANNELS.runnerStatusChanged, handler)
  },
})
