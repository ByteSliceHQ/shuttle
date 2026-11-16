import { describe, expect, test } from 'bun:test'

import { describeSandbox, follow } from './local-sandbox-status'

describe('describeSandbox', () => {
  test('says nothing when the sandbox is up or nobody is signed in', () => {
    expect(describeSandbox(null)).toBeNull()
    expect(describeSandbox({ status: 'online' })).toBeNull()
    expect(describeSandbox({ status: 'unauthorized' })).toBeNull()
  })

  test('tells a first setup, which the runner narrates, from a plain start', () => {
    expect(describeSandbox({ status: 'preparing', message: 'Installing the tools' })).toEqual({
      kind: 'setup',
      title: 'Setting up your sandbox',
      detail: 'Installing the tools. This happens once and takes about a minute.',
    })

    expect(describeSandbox({ status: 'preparing' })).toMatchObject({
      title: 'Starting your sandbox',
    })

    expect(describeSandbox({ status: 'connecting' })).toMatchObject({
      title: 'Starting your sandbox',
    })
  })

  test('passes on what went wrong', () => {
    expect(describeSandbox({ status: 'error', message: 'No disk space' })).toEqual({
      kind: 'problem',
      title: 'The local sandbox could not start',
      detail: 'No disk space',
    })
  })
})

describe('follow', () => {
  const nothing = { status: null, setupSince: null, readyUntil: null }

  test('says ready after a setup that was long enough to be shown', () => {
    const waiting = follow(nothing, { status: 'preparing' }, 1000)
    const done = follow(waiting, { status: 'online' }, 31_000)

    expect(waiting.setupSince).toBe(1000)
    expect(done.readyUntil).toBe(36_000)
  })

  test('stays quiet about a start too quick to have been shown', () => {
    const waiting = follow(nothing, { status: 'starting' }, 1000)

    expect(follow(waiting, { status: 'online' }, 1300).readyUntil).toBeNull()
  })
})
