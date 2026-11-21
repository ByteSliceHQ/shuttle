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
  readonly version?: string
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
    (!('version' in value) || isString(value.version)) &&
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
const temporaryRoot = await mkdtemp(join(tmpdir(), 'shuttle-package-'))
const npm = Bun.which('npm')

interface PublishedPackage {
  /** Its folder under `packages`. */
  readonly folder: string
  /** The private packages it is put together from, by their folders. */
  readonly parts: readonly string[]
  /** Files its tarball must have, besides the ones every package has. */
  readonly required: readonly string[]
}

const shuttle: PublishedPackage = {
  folder: 'shuttle',
  parts: ['api', 'core', 'react', 'engine', 'sandbox', 'git', 'runner-protocol'],
  required: [
    'dist/api/index.js',
    'dist/api/index.d.ts',
    'dist/core/workspace.js',
    'dist/core/pulls.d.ts',
    'dist/react/index.js',
    'dist/react/index.d.ts',
    'dist/react/ui.js',
    'dist/react/theme.css',
    'dist/engine/index.js',
    'dist/engine/index.d.ts',
    'dist/engine/worker.js',
    'dist/engine/api/serve.d.ts',
    'dist/git/access.d.ts',
    'dist/sandbox/lib/session-sandbox.js',
    'dist/sandbox/bridge/protocol.d.ts',
    'dist/runner-protocol/index.js',
  ],
}

/** Checks one published package against its parts, packs it, and answers its manifest and tarball. */
async function packed(spec: PublishedPackage): Promise<{ manifest: Manifest; tarball: string }> {
  const packageRoot = join(root, 'packages', spec.folder)

  // A published package lists its dependencies by hand. They have to be the ones the packages
  // it is put together from ask for, or an install outside this repository lacks one.
  const manifest = await manifestOf(packageRoot)
  const drift: string[] = []

  for (const name of spec.parts) {
    const part = await manifestOf(join(root, 'packages', name))

    // What a part depends on is a dependency of the package, or, for what only a host that runs
    // the engine needs, a peer it installs itself. Either way at the range the part asks for.
    for (const [dependency, range] of Object.entries(part.dependencies ?? {})) {
      const listed = manifest.dependencies?.[dependency] ?? manifest.peerDependencies?.[dependency]

      if (!range.startsWith('workspace:') && listed !== range) {
        drift.push(`${dependency}@${range} (from @shuttle/${name})`)
      }
    }

    for (const dependency of Object.keys(part.peerDependencies ?? {})) {
      if (!manifest.peerDependencies?.[dependency]) {
        drift.push(`peer ${dependency} (from @shuttle/${name})`)
      }
    }
  }

  if (drift.length > 0) {
    throw new Error(
      `packages/${spec.folder}/package.json is missing or disagrees on:\n${drift.join('\n')}`,
    )
  }

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
    throw new Error(`The ${spec.folder} tarball has files it should not:\n${forbidden.join('\n')}`)
  }

  const everyPackage = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']
  const missing = [...spec.required, ...everyPackage].filter((path) => !paths.has(path))

  if (missing.length > 0) {
    throw new Error(`The ${spec.folder} tarball is missing:\n${missing.join('\n')}`)
  }

  // Nothing published may still name a private package, or it cannot be installed.
  for (const file of new Bun.Glob('**/*.{js,d.ts}').scanSync(join(packageRoot, 'dist'))) {
    if ((await readFile(join(packageRoot, 'dist', file), 'utf8')).includes('@shuttle/')) {
      throw new Error(`packages/${spec.folder}/dist/${file} still names a private @shuttle package`)
    }
  }

  return { manifest, tarball }
}

try {
  await run(['bun', 'x', 'turbo', 'run', 'build', '--filter=@swirls/shuttle...'], root)

  const { manifest: published, tarball } = await packed(shuttle)

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
    // The engine's types name a Worker's bindings, which a host's own tsconfig supplies.
    '@cloudflare/workers-types',
    // What a host that runs the engine installs beside the package: its optional peers.
    ...['ai', '@cloudflare/sandbox', '@daytona/sdk'].map(
      (peer) => `${peer}@${published.peerDependencies?.[peer] ?? 'latest'}`,
    ),
    // Looms takes any `effect` from the one we pin upwards. A host installs ours, as it has to
    // for the two to share one copy.
    ...(published.dependencies?.effect === undefined
      ? []
      : [`effect@${published.dependencies.effect}`]),
  ]

  if (npm) {
    await run([npm, 'install', '--ignore-scripts', '--no-package-lock', ...installed], fixture)
  } else {
    await run(['bun', 'add', '--ignore-scripts', ...installed], fixture)
  }

  // The engine's modules are exported by pattern. These stand for them: the root, ones a host
  // imports by name, and one from each part behind a pattern. None needs a Worker to load.
  const hosted = [
    '@swirls/shuttle/engine',
    '@swirls/shuttle/engine/agents/intake',
    '@swirls/shuttle/engine/api/serve',
    '@swirls/shuttle/engine/harness',
    '@swirls/shuttle/engine/session/module',
    '@swirls/shuttle/engine/tenancy/access',
    '@swirls/shuttle/engine/tenancy/run-names',
    '@swirls/shuttle/engine/testing/fake-env',
    '@swirls/shuttle/engine/workspace/module',
    '@swirls/shuttle/git/access',
    '@swirls/shuttle/sandbox/names',
    '@swirls/shuttle/sandbox/bridge/protocol',
    '@swirls/shuttle/runner-protocol',
  ]

  // The engine's types name a Worker's bindings, so it is checked as a host's Worker would
  // compile it, further down, and not with the parts a page uses.
  const entries = Object.keys(published.exports ?? {})
    .filter((entry) => !entry.endsWith('.css') && !entry.includes('*'))
    .filter((entry) => !/^\.\/(engine|runner-protocol)/.test(entry))
    .map((entry) => `@swirls/shuttle${entry.slice(1)}`)

  // What has no need of a browser loads in Node as it is, with every import naming its file.
  const headless = [...entries.filter((entry) => !entry.includes('/react')), ...hosted]

  await writeFile(join(fixture, 'smoke.mjs'), `${imports(headless)}\nconsole.log('imports ok')\n`)

  // Every entry, used the way a host uses it: types checked, ours included, and bundled.
  await writeFile(
    join(fixture, 'smoke.tsx'),
    `${imports(entries)}
import { sessionTenant } from '@swirls/shuttle/api'
import { createShuttleHost, defaultArtifactTypes, Shuttle, useSession, type ArtifactType } from '@swirls/shuttle/react'

const host = createShuttleHost({ baseUrl: 'https://shuttle.example/shuttle' })
const tenant = sessionTenant({ user: { id: 'u1', name: 'Ada', email: 'ada@example.com' }, orgId: 'org1' })
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

void [host, tenant, ${entries.map((_, index) => `module${index}`).join(', ')}]
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

  // The engine as a host's Worker uses it: its own run and sandbox classes, a port replaced, and
  // a headless session. The Durable Object classes load only in a Worker, so this one is checked
  // and not run.
  await writeFile(
    join(fixture, 'host.ts'),
    `${imports(hosted)}
import {
  fixedGitAccess,
  headlessSessions,
  serveShuttle,
  type EngineEnv,
  type SessionOutcome,
  type ShuttleHost,
} from '@swirls/shuttle/engine'
import {
  EventFirehose,
  SessionSandbox,
  ShuttleRun,
  shuttleApiModules,
} from '@swirls/shuttle/engine/worker'

export { EventFirehose }

const git = fixedGitAccess('token')

export class Run extends ShuttleRun<EngineEnv> {
  protected override host(env: EngineEnv): ShuttleHost {
    return { env, ports: { git } }
  }
}

export class Sandbox extends SessionSandbox<EngineEnv> {
  protected override environment(env: EngineEnv) {
    return { ...env, GIT_ACCESS: git }
  }
}

export async function start(env: EngineEnv): Promise<SessionOutcome> {
  const sessions = headlessSessions({ env, ports: { git } })

  const { runId } = await sessions.start({
    acting: { kind: 'organization', orgId: 'org1', service: 'build-host' },
    brief: 'Fix the flaky checkout test',
    repositories: [{ installationId: 1, fullName: 'acme/shop', defaultBranch: 'main', private: true }],
  })

  return sessions.outcome(runId)
}

export function serve(env: EngineEnv, request: Request): Promise<Response | null> {
  return serveShuttle({ env, ports: { git } }, { modules: shuttleApiModules })(request)
}

void [${hosted.map((_, index) => `module${index}`).join(', ')}]
`,
  )

  await writeFile(
    join(fixture, 'tsconfig.host.json'),
    JSON.stringify(
      {
        compilerOptions: {
          // What docs/hosting.md says a host's tsconfig has.
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noImplicitOverride: true,
          noUncheckedIndexedAccess: true,
          // On, unlike the page's check above: the engine's declarations repeat Looms' module
          // types and effect's, which do not check by themselves without the DOM's types.
          skipLibCheck: true,
          strict: true,
          target: 'ESNext',
          types: ['@cloudflare/workers-types'],
          verbatimModuleSyntax: true,
        },
        include: ['host.ts'],
      },
      undefined,
      2,
    ),
  )

  await run(
    [join(root, 'node_modules', '.bin', 'tsc'), '--noEmit', '-p', 'tsconfig.host.json'],
    fixture,
  )

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
