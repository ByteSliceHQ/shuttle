/**
 * Puts `@swirls/shuttle` together: the one package this repository publishes.
 *
 * The parts (`@shuttle/api`, `@shuttle/core`, `@shuttle/react`, and the engine a host runs:
 * `@shuttle/engine`, `@shuttle/sandbox`, `@shuttle/git`, `@shuttle/runner-protocol`) stay private
 * and are what the apps here use, as TypeScript source. Each is compiled by `tsc`; this copies
 * their output into `dist` under its own name, so `@shuttle/react` becomes
 * `@swirls/shuttle/react`, and rewrites what they say about each other to match.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesRoot = fileURLToPath(new URL('../..', import.meta.url))
const outputRoot = join(packageRoot, 'dist')

/** Each part, and a file its build always has, to tell a part that was never built. */
const modules = {
  api: 'index.js',
  core: 'workspace.js',
  react: 'index.js',
  'runner-protocol': 'index.js',
  git: 'access.js',
  sandbox: 'src/workspace.js',
  engine: 'index.js',
} as const

const names = Object.keys(modules).join('|')

/** One of the parts, by the name the sources here import it under. */
const privateSpecifier = new RegExp(`^@shuttle/(${names})(/|$)`)
const privateName = new RegExp(`@shuttle/(${names})\\b`, 'g')

const moduleSpecifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function copyBuild(name: string, marker: string): Promise<void> {
  const source = join(packagesRoot, name, 'dist')

  if (!(await isFile(join(source, marker)))) {
    throw new Error(`Missing ${source}; build @shuttle/${name} before assembling @swirls/shuttle`)
  }

  await cp(source, join(outputRoot, name), {
    recursive: true,
    // What `bun run pack` used to leave in a package's `dist`, and source maps.
    filter: (path) => !path.endsWith('.map') && !/\/(package\.json|LICENSE|NOTICE)$/.test(path),
  })
}

/**
 * The sandbox is built from two folders, `src` and `bridge`. Nothing published is called `src`,
 * so its `src` goes out as `lib`: the two stay side by side, as they import each other.
 */
async function renameSandboxSource(): Promise<void> {
  await rename(join(outputRoot, 'sandbox', 'src'), join(outputRoot, 'sandbox', 'lib'))
}

/** A part's module as the published package exports it. */
function published(specifier: string): string {
  return specifier.replace('@shuttle/', '@swirls/shuttle/')
}

/**
 * A relative import as Node wants it: naming the file. The sources leave the extension off,
 * and name a folder to mean its `index`.
 */
async function withExtension(file: string, specifier: string): Promise<string> {
  if (/\.(js|css|json)$/.test(specifier)) {
    return specifier
  }

  const target = join(dirname(file), specifier)
  const built = file.endsWith('.d.ts') ? '.d.ts' : '.js'

  if (await isFile(`${target}${built}`)) {
    return `${specifier}.js`
  }

  if (await isFile(join(target, `index${built}`))) {
    return `${specifier}/index.js`
  }

  throw new Error(`${file} imports ${specifier}, which was not built`)
}

async function rewrite(file: string): Promise<void> {
  const contents = (await readFile(file, 'utf8')).replaceAll(/^\/\/[#@] sourceMappingURL=.*$/gm, '')
  const found = [...contents.matchAll(moduleSpecifier)]
  const renamed = new Map<string, string>()

  for (const match of found) {
    const specifier = match[3] ?? ''

    if (specifier.startsWith('.')) {
      renamed.set(specifier, await withExtension(file, specifier))
    } else if (privateSpecifier.test(specifier)) {
      renamed.set(specifier, published(specifier))
    } else if (specifier.startsWith('@shuttle/')) {
      throw new Error(`${file} imports ${specifier}, which is not published`)
    }
  }

  await writeFile(
    file,
    contents
      .replace(
        moduleSpecifier,
        (_match, prefix: string, quote: string, specifier: string) =>
          `${prefix}${quote}${renamed.get(specifier) ?? specifier}${quote}`,
      )
      // And where a comment names one of them, since comments are what an editor shows.
      .replaceAll(privateName, '@swirls/shuttle/$1'),
  )
}

async function rewriteAll(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      await rewriteAll(path)
    } else if (path.endsWith('.js') || path.endsWith('.d.ts')) {
      await rewrite(path)
    }
  }
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await Promise.all(Object.entries(modules).map(([name, marker]) => copyBuild(name, marker)))
await renameSandboxSource()
await rewriteAll(outputRoot)

// The theme tells Tailwind to read the files beside it. In the source those are the parts'
// TypeScript; here they are the built JavaScript, in the same place relative to it.
const theme = await readFile(join(packagesRoot, 'react', 'src', 'theme.css'), 'utf8')

if (!theme.includes("@source './';")) {
  throw new Error("packages/react/src/theme.css no longer has `@source './';` for Tailwind")
}

await writeFile(join(outputRoot, 'react', 'theme.css'), theme)
