/**
 * What the Release workflow runs once the version pull request is merged: publishes
 * `@swirls/shuttle` if this version is not on npm yet, after checking the package as it will
 * be installed. It is not for running from a developer's checkout.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stderr: 'inherit',
    // Passed on so changesets/action can read the `New tag:` lines, push the tags and open
    // the GitHub release.
    stdout: 'inherit',
  })

  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}`)
  }
}

const root = resolve(import.meta.dirname, '..')

const manifest: unknown = JSON.parse(
  await readFile(join(root, 'packages', 'shuttle', 'package.json'), 'utf8'),
)

if (
  typeof manifest !== 'object' ||
  manifest === null ||
  !('name' in manifest) ||
  !('version' in manifest) ||
  typeof manifest.name !== 'string' ||
  typeof manifest.version !== 'string'
) {
  throw new Error('packages/shuttle/package.json has no name or version')
}

const { name, version } = manifest

const published = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
  method: 'HEAD',
})

if (published.ok) {
  console.log(`${name}@${version} is already on npm; creating any tags the release still lacks.`)

  // `changeset publish` passes over a version that is already published and makes no tag for
  // it. `changeset tag` still prints `New tag:` for a missing one.
  await run(['bun', 'x', 'changeset', 'tag'], root)
  process.exit(0)
}

console.log(`${name}@${version} is not on npm yet; checking the package and publishing.`)
await run(['bun', 'run', 'check:package'], root)
await run(['bun', 'x', 'changeset', 'publish'], root)
