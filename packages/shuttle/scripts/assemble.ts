/**
 * Puts `@swirls/shuttle` together: the React parts, the API contract and the run events, from
 * `@shuttle/react`, `@shuttle/api` and `@shuttle/core`. See `scripts/assemble-package.ts`.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assemble } from '../../../scripts/assemble-package'

const outputRoot = await assemble({
  folder: 'shuttle',
  parts: [
    { name: 'api', marker: 'index.js' },
    { name: 'core', marker: 'workspace.js' },
    { name: 'react', marker: 'index.js' },
  ],
  publishedAs: {
    api: '@swirls/shuttle/api',
    core: '@swirls/shuttle/core',
    react: '@swirls/shuttle/react',
  },
})

// The theme tells Tailwind to read the files beside it. In the source those are the parts'
// TypeScript; here they are the built JavaScript, in the same place relative to it.
const themePath = fileURLToPath(new URL('../../react/src/theme.css', import.meta.url))
const theme = await readFile(themePath, 'utf8')

if (!theme.includes("@source './';")) {
  throw new Error("packages/react/src/theme.css no longer has `@source './';` for Tailwind")
}

await writeFile(join(outputRoot, 'react', 'theme.css'), theme)
