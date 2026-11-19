import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readAgentEvents, startAgentRun } from './agent-runs'
import { ContainerWorkspace } from './container-workspace'
import { daytonaHost, splitOutput, wrappedCommand, type DaytonaSandboxLike } from './daytona-host'
import { failureOf } from './test-failure'
import { fakeEnv } from './testing/fake-env'

/**
 * Stands in for a Daytona sandbox on this machine. Like Daytona, it runs a command through a
 * shell and hands back only what the command printed to stdout, as one string.
 */
function localSandbox() {
  const commands: string[] = []

  const sandbox: DaytonaSandboxLike = {
    process: {
      async executeCommand(command, cwd, env) {
        commands.push(command)

        const child = Bun.spawn(['sh', '-c', command], {
          cwd,
          env: { ...process.env, ...env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
        })

        return { result: await new Response(child.stdout).text(), exitCode: await child.exited }
      },
    },
    fs: {
      async uploadFile(file, remotePath) {
        mkdirSync(dirname(remotePath), { recursive: true })
        writeFileSync(remotePath, file)
      },
      async downloadFile(remotePath) {
        return readFileSync(remotePath)
      },
    },
  }

  return { sandbox, commands }
}

const text = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer)
const stream = (value: string) => new Blob([value]).stream()

async function run(
  argv: string[],
  options?: Parameters<ReturnType<typeof daytonaHost>['exec']>[1],
) {
  const output = await (await daytonaHost(localSandbox().sandbox).exec(argv, options)).output()

  return { stdout: text(output.stdout), stderr: text(output.stderr), exitCode: output.exitCode }
}

describe('daytonaHost exec', () => {
  test('keeps stdout, stderr and the exit code apart', async () => {
    expect(await run(['bash', '-c', 'echo out; echo err >&2; exit 3'])).toEqual({
      stdout: 'out\n',
      stderr: 'err\n',
      exitCode: 3,
    })
  })

  test('output without a trailing newline comes back exactly', async () => {
    expect(await run(['printf', 'no newline'])).toEqual({
      stdout: 'no newline',
      stderr: '',
      exitCode: 0,
    })
  })

  test('arguments are passed as given, whatever they contain', async () => {
    const tricky = `it's "quoted" $HOME \`date\` ; rm -rf /nope`

    expect((await run(['printf', '%s', tricky])).stdout).toBe(tricky)
  })

  test('feeds stdin from the stream it is given', async () => {
    expect((await run(['cat'], { stdin: stream('line one\nline two\n') })).stdout).toBe(
      'line one\nline two\n',
    )
  })

  test('a command with no stdin reads end of file instead of hanging', async () => {
    expect((await run(['cat'])).stdout).toBe('')
  })

  test('runs in the directory and environment asked for', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'shuttle-daytona-cwd-'))

    const result = await run(['bash', '-c', 'pwd -P; echo "$SHUTTLE_TEST_VALUE"'], {
      cwd,
      env: { SHUTTLE_TEST_VALUE: 'from env' },
    })

    expect(result.stdout.trim().split('\n')[1]).toBe('from env')
    expect(result.stdout).toContain('shuttle-daytona-cwd-')
  })

  test('leaves no temporary files behind', async () => {
    const before = readdirSync('/tmp').filter((name) => name.startsWith('.shuttle-')).length

    await run(['cat'], { stdin: stream('x') })

    expect(readdirSync('/tmp').filter((name) => name.startsWith('.shuttle-')).length).toBe(before)
  })

  test('a command the sandbox cut off is reported as a failure', async () => {
    const host = daytonaHost({
      process: { executeCommand: async () => ({ result: 'partial out', exitCode: 0 }) },
      fs: localSandbox().sandbox.fs,
    })

    const output = await (await host.exec(['sleep', '999'])).output()

    expect(text(output.stdout)).toBe('partial out')
    expect(output.exitCode).toBe(1)
    expect(text(output.stderr)).toContain('before it finished')
  })
})

describe('daytonaHost files', () => {
  test('writes, reads and creates directories', async () => {
    const host = daytonaHost(localSandbox().sandbox)
    const root = mkdtempSync(join(tmpdir(), 'shuttle-daytona-files-'))

    await host.mkdir(join(root, 'a/b'))
    await host.writeFile(join(root, 'a/b/note.txt'), 'héllo\n')

    expect(await host.readFile(join(root, 'a/b/note.txt'))).toBe('héllo\n')
  })

  test('a missing file is reported the way callers look for it', async () => {
    const host = daytonaHost(localSandbox().sandbox)

    expect(await failureOf(host.readFile('/tmp/shuttle-definitely-missing'))).toMatch(/ENOENT/)
  })
})

describe('output wrapping', () => {
  test('a marker inside the output does not confuse the split', () => {
    const marker = '__shuttle_x__'
    const split = splitOutput(`a\n${marker}\nb\n${marker}\nreal stderr`, marker)

    expect(split).toEqual({ stdout: `a\n${marker}\nb`, stderr: 'real stderr' })
    expect(splitOutput('no marker here', marker)).toBeNull()
  })

  test('the script quotes every path it touches', () => {
    const script = wrappedCommand(['echo', 'hi'], {
      marker: 'M',
      stderr: '/tmp/a b.err',
      stdin: '/tmp/a b.in',
    })

    expect(script).toContain(`< '/tmp/a b.in' 2> '/tmp/a b.err'`)
    expect(script).toContain(`rm -f '/tmp/a b.err' '/tmp/a b.in'`)
  })
})

describe('on a Daytona host', () => {
  test('the workspace reads, writes and edits files', async () => {
    const { sandbox } = localSandbox()
    const workspace = new ContainerWorkspace(async () => daytonaHost(sandbox), fakeEnv())
    const root = mkdtempSync(join(tmpdir(), 'shuttle-daytona-ws-'))

    await workspace.writeFile('src/app.ts', 'export const a = 1\n', root)
    expect(await workspace.editFile('src/app.ts', 'a = 1', 'a = 2', root)).toBe(1)
    expect(await workspace.readFile('src/app.ts', root)).toBe('export const a = 2\n')
  })

  // The workspace bounds every command with coreutils `timeout`, which the sandbox image has
  // and a developer's Mac may not.
  test.skipIf(Bun.which('timeout') === null)('the workspace runs commands', async () => {
    const { sandbox } = localSandbox()
    const workspace = new ContainerWorkspace(async () => daytonaHost(sandbox), fakeEnv())
    const root = mkdtempSync(join(tmpdir(), 'shuttle-daytona-ws-'))

    await workspace.writeFile('src/app.ts', 'export const a = 2\n', root)

    const result = await workspace.exec('cat src/app.ts; echo warn >&2; exit 2', { cwd: root })

    expect(result).toEqual({ stdout: 'export const a = 2\n', stderr: 'warn\n', exitCode: 2 })
    expect(await workspace.listFiles(root)).toEqual([join(root, 'src/app.ts')])
  })

  test('an agent run starts from a request on stdin and is followed by offset', async () => {
    const { sandbox } = localSandbox()
    const root = mkdtempSync(join(tmpdir(), 'shuttle-daytona-runs-'))
    const bridge = join(root, 'fake-bridge.sh')

    // A stand-in bridge: copies the request it is given into its events file.
    writeFileSync(
      bridge,
      [
        'dir="$3"',
        `printf '{"type":"turn_done","status":"completed","echo":%s}\\n' "$(cat "$dir/request.json")" > "$dir/events.jsonl"`,
      ].join('\n'),
    )

    const options = { root, bridge, runtime: ['bash'] }
    const request = { harness: 'codex', prompt: `fix the "bug"`, cwd: '/tmp' } as const

    const started = await startAgentRun(
      daytonaHost(sandbox),
      { runKey: 'run_1', mode: 'turn', request },
      options,
    )

    expect(started).toEqual({ started: true })

    for (let i = 0; i < 50 && !existsSync(join(root, 'run_1/events.jsonl')); i++) {
      await Bun.sleep(20)
    }

    const page = await readAgentEvents(daytonaHost(sandbox), 'run_1', 0, options)

    expect(page.done).toBe(true)
    expect(JSON.stringify(page.events[0])).toContain('fix the \\"bug\\"')

    // Starting the same run again does not start a second agent.
    expect(
      await startAgentRun(
        daytonaHost(sandbox),
        { runKey: 'run_1', mode: 'turn', request },
        options,
      ),
    ).toEqual({ started: false })
  })
})
