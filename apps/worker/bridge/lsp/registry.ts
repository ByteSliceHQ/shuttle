import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, extname, join } from 'node:path'

/**
 * The language servers `shuttle-lsp` knows how to run. Adding a language is adding an entry
 * here: which files it covers, how to find the project a file belongs to, and how to start it.
 */

export interface LaunchCommand {
  readonly command: string
  readonly args: readonly string[]
}

export type Launch = LaunchCommand | { readonly unavailable: string }

export interface ServerDefinition {
  readonly id: string
  /** File extension, with its dot, to the language id LSP's `didOpen` wants. */
  readonly languages: Readonly<Record<string, string>>
  /** Files that mark a project's root. The nearest directory holding one is the root. */
  readonly rootMarkers: readonly string[]
  /** How to start the server for a project, or why it cannot be started here. */
  launch(root: string): Launch
}

export interface ResolvedServer {
  readonly definition: ServerDefinition
  readonly languageId: string
  readonly root: string
}

/** The first directory at or above `start` that holds `relative`. */
function findUp(start: string, relative: string): string | null {
  let dir = start

  for (;;) {
    if (existsSync(join(dir, relative))) {
      return dir
    }

    const parent = dirname(dir)

    if (parent === dir) {
      return null
    }

    dir = parent
  }
}

export function onPath(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue
    }

    const candidate = join(dir, command)

    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }

  return null
}

/**
 * TypeScript 7 is its own language server (`tsc --lsp`). Before 7 the compiler only ships
 * `tsserver`, which `typescript-language-server` wraps. A project is checked with the
 * TypeScript it installed, so its diagnostics match what its own `tsc` reports; without one,
 * the TypeScript baked into the sandbox image stands in.
 */
/** The major version of the TypeScript package in `packageDir`. Zero when it cannot be read. */
function typescriptMajor(packageDir: string): number {
  try {
    const version = (
      JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }
    ).version

    return Number(version?.split('.')[0] ?? 0) || 0
  } catch {
    return 0
  }
}

function launchTypeScript(root: string): Launch {
  const home = findUp(root, 'node_modules/typescript/package.json')
  const local = home ? join(home, 'node_modules/typescript') : null
  const global = onPath('tsc')
  // `tsc` on the PATH is a link into the package it belongs to: <package>/bin/tsc.
  const globalDir = global ? dirname(dirname(realpathSync(global))) : null

  for (const packageDir of [local, globalDir]) {
    const major = packageDir ? typescriptMajor(packageDir) : 0

    if (packageDir && major >= 7) {
      return { command: process.execPath, args: [join(packageDir, 'bin/tsc'), '--lsp', '--stdio'] }
    }

    if (major > 0) {
      const wrapper = onPath('typescript-language-server')

      return wrapper
        ? { command: wrapper, args: ['--stdio'] }
        : {
            unavailable: `TypeScript ${major} needs typescript-language-server, and it is not installed`,
          }
    }
  }

  return { unavailable: 'TypeScript is not installed in this project or in the sandbox' }
}

export const SERVERS: readonly ServerDefinition[] = [
  {
    id: 'typescript',
    languages: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    launch: launchTypeScript,
  },
]

/** The server for a file and the project root it runs in, or null when no server covers it. */
export function resolveServer(
  file: string,
  servers: readonly ServerDefinition[] = SERVERS,
): ResolvedServer | null {
  const extension = extname(file).toLowerCase()

  for (const definition of servers) {
    const languageId = definition.languages[extension]

    if (!languageId) {
      continue
    }

    const dir = dirname(file)

    // Markers are tried in order, so a tsconfig above the file wins over a nearer package.json.
    for (const marker of definition.rootMarkers) {
      const root = findUp(dir, marker)

      if (root) {
        return { definition, languageId, root }
      }
    }

    return { definition, languageId, root: dir }
  }

  return null
}
