import { describe, expect, test } from 'bun:test'

import { fakeEnv } from '../testing/fake-env'
import { finishSetup, startInstall } from './github'

const ORG_ID = 'org1'

const app = {
  GITHUB_APP_SLUG: 'shuttle-test',
  GITHUB_STATE_SECRET: 'state-secret',
  SHUTTLE_WEB_URL: 'https://shuttle.example.com',
}

const oauth = { ...app, GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret' }

function location(response: Response): URL {
  expect(response.status).toBe(302)

  return new URL(response.headers.get('location') ?? '')
}

describe('connecting github', () => {
  test('identifies the person first when the App has an OAuth client', async () => {
    const target = location(await startInstall(fakeEnv(oauth), ORG_ID))

    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize')
  })

  test('adding another account goes to the install page, where one can be picked', async () => {
    const target = location(await startInstall(fakeEnv(oauth), ORG_ID, true))

    expect(target.origin + target.pathname).toBe(
      'https://github.com/apps/shuttle-test/installations/new',
    )

    expect(target.searchParams.get('state')).toStartWith(`install:${ORG_ID}:`)
  })

  test('without an OAuth client the install page is the only way in', async () => {
    const target = location(await startInstall(fakeEnv(app), ORG_ID))

    expect(target.pathname).toBe('/apps/shuttle-test/installations/new')
  })

  test('adding an organization without an App slug falls back to identifying the person', async () => {
    const target = location(
      await startInstall(fakeEnv({ ...oauth, GITHUB_APP_SLUG: undefined }), ORG_ID, true),
    )

    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize')
  })

  test('coming back from an install still identifies the person before linking', async () => {
    const env = fakeEnv(oauth)
    const state = location(await startInstall(env, ORG_ID, true)).searchParams.get('state') ?? ''

    const setup = new URL('https://worker.example.com/github/setup?installation_id=7')

    setup.searchParams.set('state', state)

    const target = location(await finishSetup(setup, env))

    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize')
  })

  test('an install that only asked the owners links nothing', async () => {
    const setup = new URL('https://worker.example.com/github/setup?setup_action=request')
    const target = location(await finishSetup(setup, fakeEnv(oauth)))

    expect(target.toString()).toBe('https://shuttle.example.com/?github=requested')
  })
})
