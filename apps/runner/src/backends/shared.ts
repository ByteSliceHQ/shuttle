/** What every backend that drives a sandbox through a command line has in common. */

/** Runs `"$@"` after printing the shell's own pid, which `exec` then hands to the command. */
export const ANNOUNCE_PID = 'printf "%s\\n" "$$" >&2; exec "$@"'

/** Reads one request as JSON on stdin, makes it against the sandbox's loopback, prints the answer. */
export const HTTP_SCRIPT = `
let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (text += chunk))
process.stdin.on('end', async () => {
  const request = JSON.parse(text)
  const hasBody = request.body && request.method !== 'GET' && request.method !== 'HEAD'
  try {
    const response = await fetch('http://127.0.0.1:' + request.port + request.path, {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
      ...(hasBody ? { body: Buffer.from(request.body, 'base64') } : {}),
    })
    const body = Buffer.from(await response.arrayBuffer()).toString('base64')
    process.stdout.write(JSON.stringify({ status: response.status, headers: [...response.headers], body }))
  } catch (cause) {
    process.stderr.write(String(cause && cause.cause ? cause.cause.message || cause.cause : cause))
    process.exit(7)
  }
})
`

export async function collect(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  return stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : new Uint8Array()
}

export function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * Reads the stderr of a command started through `ANNOUNCE_PID`. Its first line is the pid,
 * reported as soon as it arrives, which is long before the command ends; the rest is the
 * command's own stderr.
 */
export async function readAnnouncedPid(
  stream: ReadableStream<Uint8Array>,
  started?: (pid: number) => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let announced = false

  for await (const chunk of stream) {
    chunks.push(chunk)

    if (!announced) {
      const seen = Buffer.concat(chunks)
      const line = seen.indexOf(0x0a)

      if (line >= 0) {
        announced = true

        const pid = Number(seen.subarray(0, line).toString('utf8'))

        if (Number.isInteger(pid) && pid > 0) {
          started?.(pid)
          chunks.length = 0
          chunks.push(seen.subarray(line + 1))
        }
      }
    }
  }

  return new Uint8Array(Buffer.concat(chunks))
}
