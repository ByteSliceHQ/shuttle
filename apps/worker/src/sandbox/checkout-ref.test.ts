import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $ } from 'bun'

import { checkoutRefScript } from './container-workspace'
import { baseCommitScript } from './workspace-summary'

const git = ['git', '-c', 'user.name=Test', '-c', 'user.email=test@local']

/** A repository with `main` and a pull request branch one commit ahead of it. */
async function origin() {
  const root = mkdtempSync(join(tmpdir(), 'shuttle-checkout-'))
  const remote = join(root, 'origin')

  await $`git init -q -b main ${remote}`.quiet()
  await $`git -C ${remote} config uploadpack.allowAnySHA1InWant true`.quiet()
  writeFileSync(join(remote, 'README.md'), 'Demo\n')
  await $`${git} -C ${remote} add -A`.quiet()
  await $`${git} -C ${remote} commit -q -m init`.quiet()

  const baseSha = (await $`git -C ${remote} rev-parse HEAD`.text()).trim()

  await $`git -C ${remote} checkout -q -b feature`.quiet()
  writeFileSync(join(remote, 'app.js'), 'console.log("hi")\n')
  await $`${git} -C ${remote} add -A`.quiet()
  await $`${git} -C ${remote} commit -q -m feature`.quiet()

  const headSha = (await $`git -C ${remote} rev-parse HEAD`.text()).trim()

  await $`git -C ${remote} checkout -q main`.quiet()

  const source = join(root, 'repos/demo')
  const target = join(root, '.wt/run/demo')
  const branch = 'shuttle/run/demo'

  const checkout = (sha: string, base?: string) =>
    $`bash -c ${checkoutRefScript({
      source,
      target,
      branch,
      cloneUrl: `file://${remote}`,
      basicAuth: 'unused',
      sha,
      ...(base ? { baseSha: base } : {}),
    })}`
      .quiet()
      .nothrow()

  return { source, target, branch, baseSha, headSha, checkout }
}

describe('checkoutRefScript', () => {
  test("the session worktree is the pull request's head on the session branch", async () => {
    const repo = await origin()
    const result = await repo.checkout(repo.headSha, repo.baseSha)

    expect(result.exitCode).toBe(0)
    expect(readdirSync(repo.target).toSorted()).toEqual(['.git', 'README.md', 'app.js'])
    expect((await $`git -C ${repo.target} rev-parse HEAD`.text()).trim()).toBe(repo.headSha)

    expect((await $`git -C ${repo.target} rev-parse --abbrev-ref HEAD`.text()).trim()).toBe(
      repo.branch,
    )

    // The base came along, so the pull request can be diffed where it is checked out.
    const changed = await $`git -C ${repo.target} diff --name-only ${repo.baseSha} HEAD`.text()

    expect(changed.trim()).toBe('app.js')

    // And what the session counts as changed is measured from that base, not the default branch.
    const base =
      await $`bash -c ${`cd ${repo.target} && ${baseCommitScript('main')} && echo "$base"`}`.text()

    expect(base.trim()).toBe(repo.baseSha)
  })

  test('without a base, changes are measured as in any other session', async () => {
    const repo = await origin()

    await repo.checkout(repo.headSha)

    const base =
      await $`bash -c ${`cd ${repo.target} && ${baseCommitScript('main')}; echo "$base"`}`.text()

    expect(base.trim()).not.toBe(repo.baseSha)
  })

  test('a worktree already there is replaced', async () => {
    const repo = await origin()

    await repo.checkout(repo.baseSha)
    expect(readdirSync(repo.target).toSorted()).toEqual(['.git', 'README.md'])

    const result = await repo.checkout(repo.headSha)

    expect(result.exitCode).toBe(0)
    expect(readdirSync(repo.target)).toContain('app.js')
  })

  test('a commit that cannot be fetched fails instead of leaving an empty worktree', async () => {
    const repo = await origin()
    const result = await repo.checkout('0123456789012345678901234567890123456789')

    expect(result.exitCode).not.toBe(0)
  })
})
