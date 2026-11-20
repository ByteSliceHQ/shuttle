import { describe, expect, test } from 'bun:test'

import { PUBLIC_DEPLOY_VARS, splitDeployVars } from './deploy-config-lib'

describe('splitDeployVars', () => {
  test('keeps settings in vars and credentials in secrets', () => {
    const result = splitDeployVars({
      SHUTTLE_WEB_URL: 'https://app.shuttle.codes',
      GITHUB_APP_PRIVATE_KEY: 'pem',
      BETTER_AUTH_SECRET: 'session',
      SHUTTLE_CREDENTIALS_KEY: 'key',
    })

    expect(result.vars).toEqual({ SHUTTLE_WEB_URL: 'https://app.shuttle.codes' })

    expect(result.secrets).toEqual({
      GITHUB_APP_PRIVATE_KEY: 'pem',
      BETTER_AUTH_SECRET: 'session',
      SHUTTLE_CREDENTIALS_KEY: 'key',
    })
  })

  test('treats a name it does not list as a secret', () => {
    const result = splitDeployVars({ SOMETHING_NEW_API_KEY: 'value' })

    expect(result.vars).toEqual({})
    expect(result.secrets).toEqual({ SOMETHING_NEW_API_KEY: 'value' })
  })

  test('splits every name into exactly one side', () => {
    const overrides = Object.fromEntries(
      [...PUBLIC_DEPLOY_VARS, 'GITHUB_APP_PRIVATE_KEY'].map((name) => [name, 'value']),
    )

    const result = splitDeployVars(overrides)

    expect(Object.keys(result.vars)).toHaveLength(PUBLIC_DEPLOY_VARS.size)
    expect(result.secrets).toEqual({ GITHUB_APP_PRIVATE_KEY: 'value' })

    expect(Object.keys({ ...result.vars, ...result.secrets })).toHaveLength(
      PUBLIC_DEPLOY_VARS.size + 1,
    )
  })

  test('accepts an empty deployment', () => {
    expect(splitDeployVars({})).toEqual({ vars: {}, secrets: {} })
  })
})

describe('PUBLIC_DEPLOY_VARS', () => {
  test('holds no credential the Worker reads as a secret', () => {
    for (const name of [
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_STATE_SECRET',
      'GITHUB_TOKEN',
      'BETTER_AUTH_SECRET',
      'SHUTTLE_CREDENTIALS_KEY',
      'SHUTTLE_SIGNUP_CODE',
      'DAYTONA_API_KEY',
      'OPENROUTER_API_KEY',
      'TYPESAFE_AI_API_KEY',
      'PIERRE_PRIVATE_KEY',
    ]) {
      expect(PUBLIC_DEPLOY_VARS.has(name)).toBe(false)
    }
  })
})
