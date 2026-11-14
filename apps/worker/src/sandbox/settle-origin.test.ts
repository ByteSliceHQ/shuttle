import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $ } from 'bun'

import { settleOriginScript } from './container-workspace'

const GITHUB = 'https://github.com/acme/glue.git'
const MIRROR = 'https://acme.code.storage/org-a/acme--glue.git'

async function checkout(origin: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'shuttle-origin-'))
  const target = join(root, 'repos/glue')

  await $`git init -q -b main ${target}`.quiet()

  if (origin) {
    await $`git -C ${target} remote add origin ${origin}`.quiet()
  }

  const settle = async (cloneUrl: string) => {
    const script = settleOriginScript({
      target,
      cloneUrl,
      sameRepo: [GITHUB, MIRROR],
      aside: join(root, '.replaced/glue'),
    })

    await $`bash -c ${script}`.quiet()
  }

  const readOrigin = async () =>
    (await $`git -C ${target} config --get remote.origin.url`.quiet().nothrow().text()).trim()

  return { root, target, settle, origin: readOrigin }
}

describe('settleOriginScript', () => {
  test('a clone from GitHub is repointed at the mirror and left in place', async () => {
    const repo = await checkout(GITHUB)

    await repo.settle(MIRROR)

    expect(await repo.origin()).toBe(MIRROR)
    expect(existsSync(join(repo.root, '.replaced'))).toBe(false)
  })

  test('a clone that already reads the right place is untouched', async () => {
    const repo = await checkout(MIRROR)

    await repo.settle(MIRROR)

    expect(await repo.origin()).toBe(MIRROR)
    expect(existsSync(join(repo.target, '.git'))).toBe(true)
  })

  test('some other repository under the same name is moved aside', async () => {
    const other = await checkout('https://github.com/someone-else/glue.git')
    const demo = await checkout(null)

    await other.settle(MIRROR)
    await demo.settle(GITHUB)

    for (const repo of [other, demo]) {
      expect(existsSync(repo.target)).toBe(false)
      expect(readdirSync(join(repo.root, '.replaced'))).toHaveLength(1)
    }
  })

  test('nothing happens where there is no checkout yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuttle-origin-'))

    const script = settleOriginScript({
      target: join(root, 'repos/glue'),
      cloneUrl: MIRROR,
      sameRepo: [GITHUB, MIRROR],
      aside: join(root, '.replaced/glue'),
    })

    await $`bash -c ${script}`.quiet()

    expect(readdirSync(root)).toEqual([])
  })
})
