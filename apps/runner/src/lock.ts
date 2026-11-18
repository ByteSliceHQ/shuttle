import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * One runner per sandbox on a machine. Two would each think the sandbox was theirs and keep
 * taking the connection from one another, so the second one to start says so and stops.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (cause) {
    // No such process. Anything else (no permission to signal it) means it exists.
    return !(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
  }
}

/** Where runners keep their state: `SHUTTLE_RUNNER_HOME`, else `~/.shuttle/runner`. */
export function runnerHome(): string {
  return process.env.SHUTTLE_RUNNER_HOME ?? join(homedir(), '.shuttle', 'runner')
}

/**
 * Takes the lock for the sandbox named `key`. Returns a function that gives it back, or null
 * when another runner that is still running holds it.
 */
export function takeLock(key: string, home = runnerHome()): (() => void) | null {
  const file = join(home, `${key}.lock`)

  mkdirSync(home, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Fails if the file exists, so two runners starting together cannot both get it.
      writeFileSync(file, String(process.pid), { flag: 'wx' })

      return () => {
        try {
          if (readFileSync(file, 'utf8') === String(process.pid)) {
            rmSync(file)
          }
        } catch {
          // Already gone.
        }
      }
    } catch {
      const holder = Number(readFileSync(file, 'utf8').trim())

      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) {
        return null
      }

      // Left by a runner that died. Clear it and try once more.
      rmSync(file, { force: true })
    }
  }

  return null
}
