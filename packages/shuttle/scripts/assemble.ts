/**
 * Puts `@swirls/shuttle` together, the one package this repository publishes: the React parts,
 * the API contract and the run events, and the engine a host runs sessions on with its sandbox
 * and Git parts. Each is a subpath of the package, as `@shuttle/react` is `@swirls/shuttle/react`.
 * See `scripts/assemble-package.ts`.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assemble } from '../../../scripts/assemble-package'

const outputRoot = await assemble({
  folder: 'shuttle',
  parts: [
    { name: 'api', marker: 'index.js' },
    { name: 'core', marker: 'workspace.js' },
    { name: 'react', marker: 'index.js' },
    { name: 'engine', marker: 'index.js' },
    { name: 'sandbox', marker: 'src/workspace.js' },
    { name: 'git', marker: 'access.js' },
    { name: 'runner-protocol', marker: 'index.js' },
  ],
  publishedAs: {
    api: '@swirls/shuttle/api',
    core: '@swirls/shuttle/core',
    react: '@swirls/shuttle/react',
    engine: '@swirls/shuttle/engine',
    sandbox: '@swirls/shuttle/sandbox',
    git: '@swirls/shuttle/git',
    'runner-protocol': '@swirls/shuttle/runner-protocol',
  },
})

// The sandbox is built from two folders, `src` and `bridge`. Nothing published is called `src`,
// so its `src` goes out as `lib`: the two stay side by side, as they import each other.
await rename(join(outputRoot, 'sandbox', 'src'), join(outputRoot, 'sandbox', 'lib'))

// The theme tells Tailwind to read the files beside it. In the source those are the parts'
// TypeScript; here they are the built JavaScript, in the same place relative to it.
const themePath = fileURLToPath(new URL('../../react/src/theme.css', import.meta.url))
const theme = await readFile(themePath, 'utf8')

if (!theme.includes("@source './';")) {
  throw new Error("packages/react/src/theme.css no longer has `@source './';` for Tailwind")
}

await writeFile(join(outputRoot, 'react', 'theme.css'), theme)
