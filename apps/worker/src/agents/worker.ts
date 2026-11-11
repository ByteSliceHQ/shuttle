import { z } from 'zod'

import { defineAgent } from '@swirls/looms/agent'

import type { ShuttleEnv } from '../env'
import { createSandboxTools } from '../tools/sandbox'

export function createWorkerAgent(env: ShuttleEnv, runId: string, storage?: DurableObjectStorage) {
  const tools = createSandboxTools(env, runId, storage)

  return defineAgent({
    name: 'worker',
    description: 'Implements a focused coding task in the shared session worktree',
    conversational: false,
    maxTurns: 60,
    input: z.object({
      text: z.string().describe('Task description from the conductor'),
    }),
    instructions: [
      'You are a Shuttle coding worker.',
      'All workers in this session share one worktree per repo under /workspace/.wt/<run>/<repo>.',
      'When multiple repositories are linked, each repo is a sibling directory named after the repo.',
      'Use read_file, edit_file, write_file, grep, bash, and git_diff.',
      'Never search outside /workspace. If an expected file is missing, report that back instead of hunting the filesystem.',
      'Container baseline tools: node, npm, python3, git, rg, curl, bash.',
      'Prefer project-local installs (npm install / pip in the worktree) over system packages.',
      'System packages via apk add are allowed when needed; they vanish if the container is recreated.',
      'HTTP servers must listen on 0.0.0.0 (not 127.0.0.1). Start them in the background with nohup or setsid.',
      'Tell the user to open the Browser tab with the port number (e.g. 3000). If the container restarts, start the server again.',
      'Prefer small, correct edits.',
      'When the brief is updated via a steer message, follow the new brief.',
      'When finished, summarize what you changed and call it done.',
    ].join(' '),
    tools: [tools.readFile, tools.writeFile, tools.editFile, tools.grep, tools.bash, tools.gitDiff],
  })
}
