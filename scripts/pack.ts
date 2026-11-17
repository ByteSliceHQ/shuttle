#!/usr/bin/env bun
/**
 * Builds the packages another repository can install and writes each as a tarball in
 * `out/packs`: `@shuttle/api`, `@shuttle/core` and `@shuttle/react`.
 *
 * Inside this repository the packages are used as TypeScript source, which is what makes
 * editing one show at once in the app. Outside it they are JavaScript with type declarations,
 * so a host needs no path aliases and none of this repository's settings. Each is compiled by
 * `tsc` file for file, with imports left as written, for a bundler to put together.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'out/packs')

/** In the order they depend on each other: each is compiled against the ones before it. */
const PACKAGES = ['api', 'core', 'react'] as const

interface Manifest {
  name: string
  version: string
  description?: string
  license?: string
  exports: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' })

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed in ${cwd}`)
  }
}

function manifestOf(name: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))
}

const versions = new Map(PACKAGES.map((name) => [manifestOf(name).name, manifestOf(name).version]))

/** Where a source entry point is once built: its JavaScript, and its types beside it. */
function builtExport(source: string): string | { types: string; default: string } {
  const path = source.replace(/^\.\/src\//, './')

  if (!/\.tsx?$/.test(path)) {
    return path
  }

  const base = path.replace(/\.tsx?$/, '')

  return { types: `${base}.d.ts`, default: `${base}.js` }
}

/** A dependency on another of these packages becomes a dependency on the version packed here. */
function builtDependencies(dependencies: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      if (!range.startsWith('workspace:')) {
        return [name, range]
      }

      const version = versions.get(name)

      if (!version) {
        throw new Error(`${name} is a workspace package that is not packed`)
      }

      return [name, version]
    }),
  )
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const name of PACKAGES) {
  const dir = join(root, 'packages', name)
  const dist = join(dir, 'dist')
  const manifest = manifestOf(name)

  rmSync(dist, { recursive: true, force: true })
  run(['bun', 'x', 'tsc', '-p', 'tsconfig.build.json'], dir)

  // What is not TypeScript and is still part of the package: a stylesheet.
  for (const source of Object.values(manifest.exports)) {
    if (!/\.tsx?$/.test(source)) {
      cpSync(join(dir, source), join(dist, source.replace(/^\.\/src\//, '')))
    }
  }

  writeFileSync(
    join(dist, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        license: manifest.license,
        type: 'module',
        sideEffects: ['*.css'],
        exports: Object.fromEntries(
          Object.entries(manifest.exports).map(([entry, source]) => [entry, builtExport(source)]),
        ),
        dependencies: builtDependencies(manifest.dependencies),
        peerDependencies: manifest.peerDependencies,
      },
      null,
      2,
    )}\n`,
  )

  // The licence goes with every copy of the package.
  for (const file of ['LICENSE', 'NOTICE']) {
    if (existsSync(join(root, file))) {
      cpSync(join(root, file), join(dist, file))
    }
  }

  run(['bun', 'pm', 'pack', '--destination', out, '--quiet'], dist)
}

console.log(`Packed ${PACKAGES.map((name) => manifestOf(name).name).join(', ')} into out/packs`)
