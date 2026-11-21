/**
 * What the Release workflow runs once the version pull request is merged: publishes
 * `@swirls/shuttle` and `@swirls/shuttle-engine` if this version of either is not on npm yet,
 * after checking the packages as they will be installed. It is not for running from a developer's checkout.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface RunResult {
  readonly exitCode: number
  /** What the command wrote, so a refusal answered by npm can be told from a real failure. */
  readonly output: string
}

/**
 * Runs a command and passes its output on: changesets/action reads the `New tag:` lines from
 * this script's stdout to push the tags and open the GitHub releases.
 */
async function run(command: readonly string[], cwd: string): Promise<RunResult> {
  const child = Bun.spawn([...command], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  const exitCode = await child.exited

  process.stdout.write(stdout)
  process.stderr.write(stderr)

  return { exitCode, output: `${stdout}\n${stderr}` }
}

async function runOrThrow(command: readonly string[], cwd: string): Promise<void> {
  const result = await run(command, cwd)

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${result.exitCode}`)
  }
}

const root = resolve(import.meta.dirname, '..')

interface PackageIdentity {
  readonly name: string
  readonly version: string
}

/** Whether a parsed `package.json` names the package and its version. */
function isPackageIdentity(value: unknown): value is PackageIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'version' in value &&
    typeof value.name === 'string' &&
    typeof value.version === 'string'
  )
}

/** The version a refusal to publish names, when it names one. */
function refusedVersion(refusal: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(refusal)?.[1]
}

/**
 * Whether npm refused to stage this version because it already holds it staged for a
 * maintainer's approval. A staged version does not answer at the version's own address, so the
 * registry's refusal is the answer that names it.
 */
function refusesStagedVersion(output: string, version: string): boolean {
  const refusal = output
    .split('\n')
    .find((line) => line.includes('Cannot publish over previously staged version'))

  if (refusal === undefined) {
    return false
  }

  const named = refusedVersion(refusal)

  // npm can print the refusal without the version, and the package spec it published on
  // another line.
  return named === undefined ? output.includes(version) : named === version
}

/** Creates the tags npm's own record of an existing version leaves the release without. */
async function createMissingTags(): Promise<void> {
  // `changeset publish` passes over a version that is already published and makes no tag for
  // it. `changeset tag` still prints `New tag:` for a missing one.
  await runOrThrow(['bun', 'x', 'changeset', 'tag'], root)
}

/** The two packages published from here. They are versioned together (`.changeset/config.json`). */
const PUBLISHED = ['shuttle', 'shuttle-engine']

async function identityOf(folder: string): Promise<PackageIdentity> {
  const manifest: unknown = JSON.parse(
    await readFile(join(root, 'packages', folder, 'package.json'), 'utf8'),
  )

  if (!isPackageIdentity(manifest)) {
    throw new Error(`packages/${folder}/package.json has no name or version`)
  }

  return manifest
}

async function isOnNpm({ name, version }: PackageIdentity): Promise<boolean> {
  const published = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    { method: 'HEAD' },
  )

  return published.ok
}

const packages = await Promise.all(PUBLISHED.map(identityOf))
const missing: PackageIdentity[] = []

for (const identity of packages) {
  if (!(await isOnNpm(identity))) {
    missing.push(identity)
  }
}

const label = packages.map(({ name, version }) => `${name}@${version}`).join(' and ')

if (missing.length === 0) {
  console.log(`${label} are already on npm; creating any tags the release still lacks.`)
  await createMissingTags()
  process.exit(0)
}

// The two share a version, so a refusal that names it is about whichever is still missing.
const [{ name, version } = { name: '', version: '' }] = missing

console.log(
  `${missing.map((identity) => `${identity.name}@${identity.version}`).join(' and ')} not on npm yet; checking the packages and publishing.`,
)

await runOrThrow(['bun', 'run', 'check:package'], root)

const publish = await run(['bun', 'x', 'changeset', 'publish'], root)

if (publish.exitCode !== 0) {
  // npm stages a publish that a maintainer approves on npmjs.com. A push that reaches main
  // before that approval finds the version absent and its own publish refused, and nothing is
  // left for this run to publish. The run that staged the version made its tag and release.
  if (refusesStagedVersion(publish.output, version)) {
    console.log(
      `${name}@${version} is staged on npm and waits for approval on npmjs.com; this run has nothing left to publish.`,
    )

    process.exit(0)
  }

  throw new Error(`bun x changeset publish exited with ${publish.exitCode}`)
}
