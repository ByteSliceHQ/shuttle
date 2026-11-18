/**
 * Checks `@swirls/shuttle` as someone else will get it: builds it, packs it the way npm does,
 * installs the tarball in an empty project outside this repository, and uses it there. It
 * never publishes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stderr: 'inherit',
    stdout: 'pipe',
  })

  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}\n${output}`)
  }

  return output
}

interface Manifest {
  readonly exports?: object
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

/** One import of each entry point, by name. */
function imports(specifiers: readonly string[]): string {
  return specifiers
    .map((specifier, index) => `import * as module${index} from '${specifier}'`)
    .join('\n')
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Whether a parsed JSON value is a plain object (not an array, not null). */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a parsed JSON value is an object whose values all satisfy `guard`. */
function isRecordOf<Value>(
  value: unknown,
  guard: (entry: unknown) => entry is Value,
): value is Readonly<Record<string, Value>> {
  return isObject(value) && Object.values(value).every(guard)
}

/** Whether a parsed `package.json` has the fields this script reads, in the shape it reads them. */
function isManifest(value: unknown): value is Manifest {
  return (
    isObject(value) &&
    (!('exports' in value) || isObject(value.exports)) &&
    (!('dependencies' in value) || isRecordOf(value.dependencies, isString)) &&
    (!('peerDependencies' in value) || isRecordOf(value.peerDependencies, isString))
  )
}

async function manifestOf(directory: string): Promise<Manifest> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))

  if (!isManifest(manifest)) {
    throw new Error(`${directory}/package.json is not shaped like a package manifest`)
  }

  return manifest
}

const root = resolve(import.meta.dirname, '..')
const packageRoot = join(root, 'packages', 'shuttle')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'shuttle-package-'))

try {
  await run(['bun', 'x', 'turbo', 'run', 'build', '--filter=@swirls/shuttle...'], root)

  // The published package lists its dependencies by hand. They have to be the ones the
  // packages it is put together from ask for, or an install outside this repository lacks one.
  const published = await manifestOf(packageRoot)
  const drift: string[] = []

  for (const name of ['api', 'core', 'react']) {
    const part = await manifestOf(join(root, 'packages', name))

    for (const [dependency, range] of Object.entries(part.dependencies ?? {})) {
      if (!range.startsWith('workspace:') && published.dependencies?.[dependency] !== range) {
        drift.push(`${dependency}@${range} (from @shuttle/${name})`)
      }
    }

    for (const dependency of Object.keys(part.peerDependencies ?? {})) {
      if (!published.peerDependencies?.[dependency]) {
        drift.push(`peer ${dependency} (from @shuttle/${name})`)
      }
    }
  }

  if (drift.length > 0) {
    throw new Error(
      `packages/shuttle/package.json is missing or disagrees on:\n${drift.join('\n')}`,
    )
  }

  const npm = Bun.which('npm')

  const packOutput = npm
    ? await run([npm, 'pack', '--json', '--pack-destination', temporaryRoot], packageRoot)
    : await run(['bun', 'pm', 'pack', '--quiet', '--destination', temporaryRoot], packageRoot)

  const filename = npm ? /"filename"\s*:\s*"([^"]+)"/.exec(packOutput)?.[1] : packOutput.trim()

  if (!filename) {
    throw new Error('The package manager did not say what it packed')
  }

  const tarball = isAbsolute(filename) ? filename : join(temporaryRoot, filename)

  const paths = new Set(
    (await run(['tar', '-tzf', tarball], root))
      .split('\n')
      .filter(Boolean)
      .map((path) => path.replace(/^package\//, '')),
  )

  const forbidden = [...paths].filter(
    (path) =>
      path.includes('/src/') ||
      /\.test\.(js|d\.ts)$/.test(path) ||
      path.endsWith('.map') ||
      /\.tsx?$/.test(path.replace(/\.d\.ts$/, '')),
  )

  if (forbidden.length > 0) {
    throw new Error(`The tarball has files it should not:\n${forbidden.join('\n')}`)
  }

  const required = [
    'dist/api/index.js',
    'dist/api/index.d.ts',
    'dist/core/workspace.js',
    'dist/core/pulls.d.ts',
    'dist/react/index.js',
    'dist/react/index.d.ts',
    'dist/react/ui.js',
    'dist/react/theme.css',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
  ]

  const missing = required.filter((path) => !paths.has(path))

  if (missing.length > 0) {
    throw new Error(`The tarball is missing:\n${missing.join('\n')}`)
  }

  // Nothing published may still name a private package, or it cannot be installed.
  for (const file of new Bun.Glob('**/*.{js,d.ts}').scanSync(join(packageRoot, 'dist'))) {
    if ((await readFile(join(packageRoot, 'dist', file), 'utf8')).includes('@shuttle/')) {
      throw new Error(`dist/${file} still names a private @shuttle package`)
    }
  }

  const fixture = join(temporaryRoot, 'fixture')

  await mkdir(fixture)

  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, undefined, 2),
  )

  const installed = [
    tarball,
    'react@^19',
    'react-dom@^19',
    '@tanstack/react-query@^5',
    '@types/react@^19',
    '@types/react-dom@^19',
    // Named by a dependency's own types, which are checked here along with ours.
    '@opentelemetry/api',
  ]

  if (npm) {
    await run([npm, 'install', '--ignore-scripts', '--no-package-lock', ...installed], fixture)
  } else {
    await run(['bun', 'add', '--ignore-scripts', ...installed], fixture)
  }

  const entries = Object.keys(published.exports ?? {})
    .filter((entry) => !entry.endsWith('.css'))
    .map((entry) => `@swirls/shuttle${entry.slice(1)}`)

  // What has no need of a browser loads in Node as it is, with every import naming its file.
  const headless = entries.filter((entry) => !entry.includes('/react'))

  await writeFile(join(fixture, 'smoke.mjs'), `${imports(headless)}\nconsole.log('imports ok')\n`)

  // Every entry, used the way a host uses it: types checked, ours included, and bundled.
  await writeFile(
    join(fixture, 'smoke.tsx'),
    `${imports(entries)}
import { createShuttleHost, defaultArtifactTypes, Shuttle, useSession, type ArtifactType } from '@swirls/shuttle/react'

const host = createShuttleHost({ baseUrl: 'https://shuttle.example' })
const notes: ArtifactType = { kind: 'acme:notes', label: 'Notes', icon: null, render: () => null }

function Strip() {
  return <p>{useSession().status}</p>
}

export function App({ sessionId }: { sessionId: string }) {
  return (
    <Shuttle.Session id={sessionId} artifactTypes={[...defaultArtifactTypes, notes]}>
      <Shuttle.SessionHeader />
      <Strip />
      <Shuttle.Conversation />
      <Shuttle.Composer />
      <Shuttle.Artifacts />
    </Shuttle.Session>
  )
}

void [host, ${entries.map((_, index) => `module${index}`).join(', ')}]
`,
  )

  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          // Off, so the declarations this package ships are checked too. One that names a
          // type it cannot import only fails for whoever installs it.
          skipLibCheck: false,
          strict: true,
          target: 'ESNext',
          types: [],
        },
        include: ['smoke.tsx'],
      },
      undefined,
      2,
    ),
  )

  await run(['bun', 'smoke.mjs'], fixture)

  const node = Bun.which('node')

  if (node) {
    await run([node, 'smoke.mjs'], fixture)
  }

  await run([join(root, 'node_modules', '.bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], fixture)

  // Bundled with the theme, as a host's page would be. Tailwind itself is the host's to run.
  await writeFile(
    join(fixture, 'page.ts'),
    "import '@swirls/shuttle/react/theme.css'\n\nexport { App } from './smoke'\n",
  )

  await run(['bun', 'build', 'page.ts', '--target', 'browser', '--outdir', 'bundled'], fixture)

  console.log('Validated the packed @swirls/shuttle')
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}
