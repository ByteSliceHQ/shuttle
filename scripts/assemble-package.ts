/**
 * Puts a published package together from the private ones it is made of.
 *
 * The parts (`@shuttle/api`, `@shuttle/react`, `@shuttle/engine` and the rest) stay private and
 * are what the apps here use, as TypeScript source. Each is compiled by `tsc`; this copies their
 * output into the published package's `dist` under its own name and rewrites what they say about
 * each other to the names they are published under.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagesRoot = fileURLToPath(new URL('../packages', import.meta.url))

export interface AssembledPart {
  /** The private package, by its folder under `packages`. */
  readonly name: string
  /** A file its build always has, to tell a part that was never built. */
  readonly marker: string
}

export interface Assembly {
  /** The published package's folder under `packages`. */
  readonly folder: string
  /** The parts copied into its `dist`, each under its own name. */
  readonly parts: readonly AssembledPart[]
  /**
   * What each private package is imported as once published, by its folder: a part of this
   * package, or of another published one it depends on. Importing a private package that is
   * not listed fails the build.
   */
  readonly publishedAs: Readonly<Record<string, string>>
}

const moduleSpecifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g
const privateSpecifier = /^@shuttle\/([a-z-]+)(\/.*)?$/

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
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

/** Puts `assembly` together into its `dist`, and answers where that is. */
export async function assemble(assembly: Assembly): Promise<string> {
  const outputRoot = join(packagesRoot, assembly.folder, 'dist')

  const published = (file: string, specifier: string): string | undefined => {
    const [, name, rest] = privateSpecifier.exec(specifier) ?? []

    if (name === undefined) {
      return undefined
    }

    const as = assembly.publishedAs[name]

    if (as === undefined) {
      throw new Error(`${file} imports ${specifier}, which is not published`)
    }

    return `${as}${rest ?? ''}`
  }

  // Longest first, so `@shuttle/runner-protocol` is not read as a shorter name.
  const names = Object.keys(assembly.publishedAs).toSorted((a, b) => b.length - a.length)
  const privateName = new RegExp(`@shuttle/(${names.join('|')})\\b`, 'g')

  const rewrite = async (file: string): Promise<void> => {
    const contents = (await readFile(file, 'utf8')).replaceAll(
      /^\/\/[#@] sourceMappingURL=.*$/gm,
      '',
    )

    const renamed = new Map<string, string>()

    for (const match of contents.matchAll(moduleSpecifier)) {
      const specifier = match[3] ?? ''

      if (specifier.startsWith('.')) {
        renamed.set(specifier, await withExtension(file, specifier))
      } else {
        const as = published(file, specifier)

        if (as !== undefined) {
          renamed.set(specifier, as)
        }
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
        .replaceAll(privateName, (_match, name: string) => assembly.publishedAs[name] ?? _match),
    )
  }

  const rewriteAll = async (directory: string): Promise<void> => {
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

  await Promise.all(
    assembly.parts.map(async ({ name, marker }) => {
      const source = join(packagesRoot, name, 'dist')

      if (!(await isFile(join(source, marker)))) {
        throw new Error(`Missing ${source}; build @shuttle/${name} before assembling`)
      }

      await cp(source, join(outputRoot, name), {
        recursive: true,
        // What `bun run pack` used to leave in a package's `dist`, and source maps.
        filter: (path) => !path.endsWith('.map') && !/\/(package\.json|LICENSE|NOTICE)$/.test(path),
      })
    }),
  )

  await rewriteAll(outputRoot)

  return outputRoot
}
