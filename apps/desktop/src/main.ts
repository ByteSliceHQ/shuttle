import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

import { CHANNELS, type DesktopInfo, type RunnerStatus } from './channels'
import { readPackagedConfig } from './config'
import { forgetMachineToken, machineToken } from './machine'
import { RunnerSupervisor } from './runner'
import { showSplash } from './splash'
import { Store } from './store'
import { startUpdates } from './updates'

/**
 * Shuttle's desktop app.
 *
 * The window is the same session UI the browser shows, loaded from a Shuttle deployment
 * (`SHUTTLE_DESKTOP_URL`, else the one the app was packaged for, else the local dev server). What the app adds is this machine:
 * it registers the machine for whoever is signed in to the window and runs a sandbox runner
 * beside it, so sessions can work here and move between here and the cloud.
 *
 * The app carries no secrets. Everything that needs one (models, GitHub, cloud sandboxes, Code
 * Storage) happens in the deployment; the one credential kept here is this machine's own token.
 */

/**
 * The app's name decides where its data lives and what its keychain entry is called, so it is
 * set before anything reads either. A copy run from the repository gets a name of its own:
 * macOS ties a keychain entry to the app that made it, and asks for the login password when a
 * differently signed app reaches for it.
 */
app.setName(app.isPackaged ? 'Shuttle' : 'Shuttle Dev')

/** What this build was packaged to use. Empty when run from the repository. */
const PACKAGED = readPackagedConfig(process.resourcesPath)

const APP_URL = (
  process.env.SHUTTLE_DESKTOP_URL ??
  PACKAGED.url ??
  'http://127.0.0.1:5180'
).replace(/\/$/, '')

const SANDBOX_IMAGE = process.env.SHUTTLE_SANDBOX_IMAGE ?? PACKAGED.image

/**
 * Where the app's own files are: `apps/desktop` run from this repository. Asked of Electron
 * because the bundler fixes `__dirname` to the source folder when it builds.
 */
const APP_ROOT = app.getAppPath()

/** This checkout, when the app is run from it. A packaged app has no repository around it. */
const REPO_ROOT = app.isPackaged ? null : resolve(APP_ROOT, '../..')

const STATUS_LABELS: Record<RunnerStatus['status'], string> = {
  starting: 'Local sandbox: starting',
  preparing: 'Local sandbox: getting ready',
  connecting: 'Local sandbox: connecting',
  online: 'Local sandbox: running',
  offline: 'Local sandbox: not connected',
  unauthorized: 'Local sandbox: sign in to use it',
  error: 'Local sandbox: unavailable',
}

/** The window's sign-in for Shuttle, as a request header. Empty when nobody is signed in. */
async function signInCookie(): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ url: APP_URL })

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

function createWindow(store: Store): BrowserWindow {
  const saved = store.get('window')

  const window = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 480,
    title: 'Shuttle',
    backgroundColor: '#0e0e11',
    webPreferences: {
      preload: join(APP_ROOT, 'dist/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  if (saved?.maximized) {
    window.maximize()
  }

  window.on('close', () => {
    store.set('window', { ...window.getNormalBounds(), maximized: window.isMaximized() })
  })

  // Links out of Shuttle (a pull request, a preview in its own tab) open in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })

  showSplash(window)

  void window.loadURL(APP_URL).catch(() => {
    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="font:14px system-ui;background:#0e0e11;color:#ededf0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p>Shuttle is not reachable at ${APP_URL}.</p><p style="color:#9a9aa6">Start it, then choose View &gt; Reload.</p></div></body>`,
      )}`,
    )
  })

  return window
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    // A packaged app carries its icon in the bundle. Run from source, the Dock would show
    // Electron's.
    if (!app.isPackaged) {
      app.dock?.setIcon(join(APP_ROOT, 'assets/icon.png'))
    }

    const store = new Store(join(app.getPath('userData'), 'state.json'))

    if (!store.get('deviceId')) {
      store.set('deviceId', `${process.platform}-${randomBytes(8).toString('hex')}`)
    }

    const info: DesktopInfo = {
      deviceId: store.get('deviceId') ?? '',
      deviceName: hostname().replace(/\.local$/, ''),
      platform: process.platform,
    }

    const sandboxContext = REPO_ROOT ? join(REPO_ROOT, 'apps/worker') : null

    const runner = new RunnerSupervisor({
      resourcesPath: process.resourcesPath,
      repoRoot: REPO_ROOT,
      settings: async () => {
        const token = await machineToken(store, APP_URL, await signInCookie(), info)

        return token
          ? {
              url: APP_URL,
              token,
              deviceName: info.deviceName,
              ...(SANDBOX_IMAGE ? { image: SANDBOX_IMAGE } : {}),
              // Run from the repository, the sandbox image is built from it when it is missing.
              ...(sandboxContext && existsSync(join(sandboxContext, 'Dockerfile'))
                ? { buildContext: sandboxContext }
                : {}),
            }
          : null
      },
      changed: (status) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(CHANNELS.runnerStatusChanged, status)
        }

        buildMenu()
      },
      // Removed from Shuttle on purpose. It is registered again only when asked to be.
      rejected: () => forgetMachineToken(store, APP_URL),
    })

    const updates = startUpdates(
      app,
      autoUpdater,
      (status) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(CHANNELS.updateStatusChanged, status)
        }
      },
      PACKAGED.autoUpdate === true,
    )

    ipcMain.handle(CHANNELS.updateStatus, () => updates.status())
    ipcMain.handle(CHANNELS.checkForUpdates, () => updates.check())
    ipcMain.handle(CHANNELS.downloadUpdate, () => updates.download())
    ipcMain.handle(CHANNELS.installUpdate, () => updates.install())

    const startsLocally = () => store.get('startLocally') !== false

    function buildMenu(): void {
      const status = runner.status()

      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
          { role: 'fileMenu' },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          {
            label: 'Sandbox',
            submenu: [
              {
                label: status.message
                  ? `${STATUS_LABELS[status.status]} (${status.message.slice(0, 60)})`
                  : STATUS_LABELS[status.status],
                enabled: false,
              },
              ...(status.backend
                ? [{ label: `Runs on ${status.backend.label}`, enabled: false }]
                : []),
              { type: 'separator' as const },
              {
                label: 'Start New Sessions on This Machine',
                type: 'checkbox' as const,
                checked: startsLocally(),
                click: (item: Electron.MenuItem) => store.set('startLocally', item.checked),
              },
              { type: 'separator' as const },
              { label: 'Reconnect This Machine', click: () => void runner.start() },
              {
                label: 'Reset Local Sandbox…',
                click: () => {
                  const choice = dialog.showMessageBoxSync({
                    type: 'warning',
                    message: 'Delete the sandbox on this machine?',
                    detail:
                      'Its session files and agent sign-ins are deleted and a new sandbox is created. Sessions that were working here keep what was last saved to the cloud.',
                    buttons: ['Cancel', 'Delete and Recreate'],
                    defaultId: 0,
                    cancelId: 0,
                  })

                  if (choice === 1) {
                    void runner.reset()
                  }
                },
              },
            ],
          },
          { role: 'windowMenu' },
        ]),
      )
    }

    ipcMain.on(CHANNELS.info, (event) => {
      event.returnValue = info
    })

    ipcMain.handle(CHANNELS.runnerStatus, () => runner.status())
    ipcMain.handle(CHANNELS.startsLocally, () => startsLocally())

    // The runner serves whoever is signed in, so it follows sign-in and sign-out.
    let signedInAs = ''
    let settle: ReturnType<typeof setTimeout> | null = null

    const followSignIn = () => {
      if (settle) {
        clearTimeout(settle)
      }

      settle = setTimeout(() => {
        void signInCookie().then((cookie) => {
          if (cookie !== signedInAs) {
            signedInAs = cookie
            void runner.start()
          }
        })
      }, 1500)
    }

    session.defaultSession.cookies.on('changed', (_event, cookie) => {
      if (new URL(APP_URL).hostname.endsWith(cookie.domain?.replace(/^\./, '') ?? '\0')) {
        followSignIn()
      }
    })

    void signInCookie().then((cookie) => {
      signedInAs = cookie
      void runner.start()
    })

    buildMenu()
    createWindow(store)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(store)
      }
    })

    app.on('before-quit', () => runner.stop())
  })

  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()

    if (window) {
      if (window.isMinimized()) {
        window.restore()
      }

      window.focus()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
