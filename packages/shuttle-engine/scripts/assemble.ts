/**
 * Puts `@swirls/shuttle-engine` together: what a host runs Shuttle's sessions on, from
 * `@shuttle/engine`, `@shuttle/sandbox`, `@shuttle/git` and `@shuttle/runner-protocol`. The API
 * contract and the run events it speaks are `@swirls/shuttle`'s, which it depends on. See
 * `scripts/assemble-package.ts`.
 */
import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { assemble } from '../../../scripts/assemble-package'

const outputRoot = await assemble({
  folder: 'shuttle-engine',
  parts: [
    { name: 'engine', marker: 'index.js' },
    { name: 'sandbox', marker: 'src/workspace.js' },
    { name: 'git', marker: 'access.js' },
    { name: 'runner-protocol', marker: 'index.js' },
  ],
  publishedAs: {
    engine: '@swirls/shuttle-engine',
    sandbox: '@swirls/shuttle-engine/sandbox',
    git: '@swirls/shuttle-engine/git',
    'runner-protocol': '@swirls/shuttle-engine/runner-protocol',
    api: '@swirls/shuttle/api',
    core: '@swirls/shuttle/core',
  },
})

// The sandbox is built from two folders, `src` and `bridge`. Nothing published is called `src`,
// so its `src` goes out as `lib`: the two stay side by side, as they import each other.
await rename(join(outputRoot, 'sandbox', 'src'), join(outputRoot, 'sandbox', 'lib'))

// The engine's own modules are exported from the package's root (`./harness`), beside the other
// parts (`./sandbox/…`, `./git/…`). A module of the engine's with one of their names would be
// hidden behind it.
const taken = new Set(['sandbox', 'git', 'runner-protocol'])

const hidden = (await readdir(join(outputRoot, 'engine')))
  .map((entry) => entry.replace(/\.(js|d\.ts)$/, ''))
  .filter((entry) => taken.has(entry))

if (hidden.length > 0) {
  throw new Error(
    `packages/engine/src has ${hidden.join(', ')}, which a part of the package is called`,
  )
}
