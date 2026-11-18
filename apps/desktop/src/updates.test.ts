import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { startUpdates } from './updates'

function setup(packaged = true, automatic = true) {
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged, getVersion: () => '1.0.0' })
  let checks = 0
  let downloads = 0
  let installs = 0
  let fail = false

  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: async () => {
      checks++
      updater.emit('checking-for-update')

      if (fail) {
        throw new Error('offline')
      }

      updater.emit('update-available', { version: '1.1.0' })
      return null
    },
    downloadUpdate: async () => {
      downloads++
      updater.emit('download-progress', { percent: 50 })
      updater.emit('update-downloaded', { version: '1.1.0' })
      return []
    },
    quitAndInstall: () => {
      installs++
    },
  })

  const service = startUpdates(
    // SAFETY: `startUpdates` uses only `isPackaged`, `getVersion` and `on` of the app, which the
    // fake has.
    app as never,
    // SAFETY: `startUpdates` uses only the methods and properties of the updater that the fake has.
    updater as never,
    () => {},
    automatic,
  )

  return {
    service,
    updater,
    counts: () => ({ checks, downloads, installs }),
    fail: (value: boolean) => {
      fail = value
    },
    close: () => app.emit('before-quit'),
  }
}

describe('desktop updates', () => {
  test('ad hoc builds offer manual downloads without checking or installing', async () => {
    const fixture = setup(true, false)

    try {
      await fixture.service.check()
      await fixture.service.download()
      fixture.service.install()
      expect(fixture.service.status().status).toBe('manual')
      expect(fixture.counts()).toEqual({ checks: 0, downloads: 0, installs: 0 })
    } finally {
      fixture.close()
    }
  })

  test('checks without downloading and installs only after an explicit request', async () => {
    const fixture = setup()

    try {
      const { service, updater } = fixture
      expect(updater.autoDownload).toBe(false)
      expect(updater.autoInstallOnAppQuit).toBe(false)
      service.install()
      await service.download()
      expect(fixture.counts()).toEqual({ checks: 0, downloads: 0, installs: 0 })
      await service.check()
      expect(service.status()).toMatchObject({ status: 'available', nextVersion: '1.1.0' })
      await service.check()
      expect(fixture.counts()).toEqual({ checks: 1, downloads: 0, installs: 0 })
      await service.download()
      expect(service.status().status).toBe('ready')
      await service.check()
      service.install()
      expect(fixture.counts()).toEqual({ checks: 1, downloads: 1, installs: 1 })
    } finally {
      fixture.close()
    }
  })

  test('recovers from a failed check and skips development builds', async () => {
    const fixture = setup()
    const development = setup(false)

    try {
      fixture.fail(true)
      await fixture.service.check()
      expect(fixture.service.status().status).toBe('error')
      fixture.fail(false)
      await fixture.service.check()
      expect(fixture.service.status().status).toBe('available')
      await development.service.check()
      expect(development.service.status().status).toBe('disabled')
      expect(development.counts().checks).toBe(0)
    } finally {
      fixture.close()
      development.close()
    }
  })
})
