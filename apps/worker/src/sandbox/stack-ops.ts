import { shellQuote } from './exec-argv'
import {
  BASE_CONFIG_KEY,
  LAYER_CONFIG_KEY,
  PARENT_CONFIG_KEY,
  branchForLayer,
  parseLayerBranch,
  parentBranchForLayer,
  type LayerAddress,
  type StackSummary,
} from './stack'
import {
  worktreeRepoPath,
  type ChangesetFile,
  type ChangesetResult,
  type ExecOptions,
  type ExecResult,
  type LayerChangesetInput,
  type NewLayerResult,
  type SealLayerResult,
  type StackStatus,
  type StackStatusLayer,
} from './workspace'

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const GREP_TIMEOUT_MS = 30_000

function recordLayerMetaCommand(branch: string, layer: number, parentBranch: string): string {
  return [
    `git config ${shellQuote(`branch.${branch}.${LAYER_CONFIG_KEY}`)} ${shellQuote(String(layer))}`,
    `git config ${shellQuote(`branch.${branch}.${PARENT_CONFIG_KEY}`)} ${shellQuote(parentBranch)}`,
  ].join(' && ')
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export interface StackOpsHost {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  ensureGitIdentity(cwd: string): Promise<void>
}

interface LayerBranch extends LayerAddress {
  readonly branch: string
}

/**
 * Git operations behind stacked layers. Every repo worktree holds one or more
 * independent stacks; each stack is a chain of layer branches off the session base.
 */
export class StackWorkspaceOps {
  constructor(private readonly host: StackOpsHost) {}

  private async git(cwd: string, command: string, timeoutMs = GREP_TIMEOUT_MS): Promise<string> {
    const result = await this.host.exec(command, { cwd, timeoutMs })

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `${command} failed in ${cwd}`)
    }

    return result.stdout
  }

  private async tryGit(cwd: string, command: string): Promise<string | null> {
    const result = await this.host.exec(command, { cwd, timeoutMs: GREP_TIMEOUT_MS })
    const value = result.stdout.trim()
    return result.exitCode === 0 && value ? value : null
  }

  async layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult> {
    const cwd = worktreeRepoPath(runId, repoName)
    const { parentRef, layerRef } = input

    const baseSha = await this.tryGit(
      cwd,
      `git rev-parse --verify ${shellQuote(`${parentRef}^{commit}`)}`,
    )

    if (!baseSha) {
      throw new Error(`Failed to resolve parent ${parentRef} in ${cwd}`)
    }

    const diff = await this.git(
      cwd,
      `git diff --name-status --no-renames -z ${shellQuote(parentRef)} ${shellQuote(layerRef)}`,
    )

    const files: ChangesetFile[] = []
    const diffTokens = diff.split('\0').filter(Boolean)

    for (let index = 0; index + 1 < diffTokens.length; index += 2) {
      const code = diffTokens[index]!
      const path = diffTokens[index + 1]!

      if (code.startsWith('D')) {
        files.push({ path, status: 'deleted', content: null })
        continue
      }

      files.push({
        path,
        status: code.startsWith('A') ? 'added' : 'modified',
        content: await this.git(cwd, `git show ${shellQuote(`${layerRef}:${path}`)}`),
      })
    }

    return { baseSha, files }
  }

  private async layerBranches(
    cwd: string,
    runId: string,
    repoName: string,
  ): Promise<LayerBranch[]> {
    const listed = await this.git(cwd, 'git for-each-ref --format="%(refname:short)" refs/heads/')

    return lines(listed)
      .flatMap((branch) => {
        const parsed = parseLayerBranch(runId, repoName, branch)
        return parsed ? [{ ...parsed, branch }] : []
      })
      .toSorted((a, b) => a.stack - b.stack || a.layer - b.layer)
  }

  private async currentAddress(
    cwd: string,
    runId: string,
    repoName: string,
  ): Promise<{ address: LayerAddress | null; branch: string }> {
    const branch = (await this.git(cwd, 'git rev-parse --abbrev-ref HEAD')).trim()
    return { address: parseLayerBranch(runId, repoName, branch), branch }
  }

  /** Session base for a stack: the commit GitHub already has that layer 1 forks from. */
  private async stackBaseSha(
    cwd: string,
    runId: string,
    repoName: string,
    stack: number,
    defaultBranch: string,
  ): Promise<string> {
    const configured = [stack, 1].map(
      (candidate) =>
        `git config --get ${shellQuote(`branch.${branchForLayer(runId, repoName, { stack: candidate, layer: 1 })}.${BASE_CONFIG_KEY}`)}`,
    )

    const resolved = await this.tryGit(
      cwd,
      [
        ...configured,
        `git rev-parse --verify ${shellQuote(`refs/remotes/origin/${defaultBranch}^{commit}`)}`,
        `git rev-parse --verify ${shellQuote(`refs/heads/${defaultBranch}^{commit}`)}`,
      ].join(' || '),
    )

    const sha = resolved?.split('\n')[0]

    if (!sha) {
      throw new Error(`No session base commit recorded for ${repoName} stack ${stack}`)
    }

    return sha
  }

  async stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus> {
    const cwd = worktreeRepoPath(runId, repoName)
    await this.host.ensureGitIdentity(cwd)

    const current = (await this.currentAddress(cwd, runId, repoName)).address ?? {
      stack: 1,
      layer: 1,
    }

    const dirty = lines(await this.git(cwd, 'git status --porcelain -uall')).map((line) =>
      line.replace(/^..\s+/, ''),
    )

    const branches = await this.layerBranches(cwd, runId, repoName)

    if (branches.length === 0) {
      const [tipSha = '', treeSha = ''] = lines(
        await this.git(cwd, 'git rev-parse HEAD HEAD^{tree}'),
      )

      const layer: StackStatusLayer = {
        stack: 1,
        layer: 1,
        branch: branchForLayer(runId, repoName, { stack: 1, layer: 1 }),
        parentBranch: defaultBranch,
        tipSha,
        treeSha,
        pending: dirty.length > 0,
        files: dirty,
      }

      return {
        repo: repoName,
        currentStack: 1,
        currentLayer: 1,
        layers: [layer],
        stacks: [{ stack: 1, baseSha: '', layers: [layer] }],
        pending: layer.pending,
      }
    }

    const stacks: StackSummary[] = []

    for (const stack of new Set(branches.map((entry) => entry.stack))) {
      const baseSha = await this.stackBaseSha(cwd, runId, repoName, stack, defaultBranch)
      const layers: StackStatusLayer[] = []

      for (const entry of branches.filter((candidate) => candidate.stack === stack)) {
        const [tipSha = '', treeSha = ''] = lines(
          await this.git(
            cwd,
            `git rev-parse ${shellQuote(entry.branch)} ${shellQuote(`${entry.branch}^{tree}`)}`,
          ),
        )

        const isCurrent = entry.stack === current.stack && entry.layer === current.layer

        const parentRef =
          entry.layer === 1
            ? baseSha
            : branchForLayer(runId, repoName, { stack, layer: entry.layer - 1 })

        const files = isCurrent
          ? dirty
          : lines(
              (await this.tryGit(
                cwd,
                `git diff --name-only ${shellQuote(parentRef)} ${shellQuote(entry.branch)}`,
              )) ?? '',
            )

        layers.push({
          stack,
          layer: entry.layer,
          branch: entry.branch,
          parentBranch: parentBranchForLayer(runId, repoName, entry, defaultBranch),
          tipSha,
          treeSha,
          pending: isCurrent && dirty.length > 0,
          files,
        })
      }

      stacks.push({ stack, baseSha, layers })
    }

    return {
      repo: repoName,
      currentStack: current.stack,
      currentLayer: current.layer,
      layers: stacks.find((entry) => entry.stack === current.stack)?.layers ?? [],
      stacks,
      pending: dirty.length > 0,
    }
  }

  /**
   * Commit pending edits on the current layer, then rebase the layers above it
   * in the same stack onto the new tip. HEAD stays on the current layer.
   */
  async sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult> {
    const cwd = worktreeRepoPath(runId, repoName)
    await this.host.ensureGitIdentity(cwd)

    const dirty = (await this.git(cwd, 'git status --porcelain -uall')).trim().length > 0

    if (!dirty) {
      const [tipSha = '', treeSha = ''] = lines(
        await this.git(cwd, 'git rev-parse HEAD HEAD^{tree}'),
      )

      return { sealed: false, tipSha, treeSha, message: null }
    }

    const oldTip = (await this.git(cwd, 'git rev-parse HEAD')).trim()

    const committed = lines(
      await this.git(
        cwd,
        [
          'git add -A',
          `git commit -q -m ${shellQuote(message)}`,
          'git rev-parse HEAD HEAD^{tree}',
        ].join(' && '),
        DEFAULT_EXEC_TIMEOUT_MS,
      ),
    )

    const tipSha = committed.at(-2) ?? ''
    const treeSha = committed.at(-1) ?? ''
    const { address, branch } = await this.currentAddress(cwd, runId, repoName)

    if (address) {
      await this.restackAbove(cwd, runId, repoName, address, branch, oldTip)
    }

    return { sealed: true, tipSha, treeSha, message }
  }

  private async restackAbove(
    cwd: string,
    runId: string,
    repoName: string,
    address: LayerAddress,
    currentBranch: string,
    oldTip: string,
  ): Promise<void> {
    const above = (await this.layerBranches(cwd, runId, repoName)).filter(
      (entry) => entry.stack === address.stack && entry.layer > address.layer,
    )

    const top = above.at(-1)

    if (!top) {
      return
    }

    const rebase = await this.host.exec(
      [
        `git checkout -q ${shellQuote(top.branch)}`,
        `git rebase --update-refs --onto ${shellQuote(currentBranch)} ${shellQuote(oldTip)} ${shellQuote(top.branch)}`,
      ].join(' && '),
      { cwd, timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
    )

    if (rebase.exitCode === 0) {
      await this.git(cwd, `git checkout -q ${shellQuote(currentBranch)}`)
      return
    }

    const unmerged = lines((await this.tryGit(cwd, 'git diff --name-only --diff-filter=U')) ?? '')

    await this.host.exec(
      `git rebase --abort 2>/dev/null; git checkout -q ${shellQuote(currentBranch)}`,
      { cwd, timeoutMs: GREP_TIMEOUT_MS },
    )

    throw new Error(
      `Restack conflict on stack ${address.stack} layer ${address.layer + 1}: ${unmerged.join(', ') || rebase.stderr.trim()}`,
    )
  }

  /** Stack a new layer on top of the current stack. */
  async newLayer(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    const cwd = worktreeRepoPath(runId, repoName)
    await this.sealLayer(runId, repoName, 'Seal before stacking')

    const status = await this.stackStatus(runId, repoName, defaultBranch)
    const top = status.layers.at(-1)

    if (!top) {
      throw new Error(`No stack layers found for ${repoName}`)
    }

    const address = { stack: status.currentStack, layer: top.layer + 1 }
    const branch = branchForLayer(runId, repoName, address)

    const tipSha = await this.git(
      cwd,
      [
        `git checkout -q -B ${shellQuote(branch)} ${shellQuote(top.branch)}`,
        recordLayerMetaCommand(branch, address.layer, top.branch),
        'git rev-parse HEAD',
      ].join(' && '),
    )

    return { ...address, branch, parentBranch: top.branch, tipSha: tipSha.trim() }
  }

  /** Start an independent stack off the session base; its layer 1 is a standalone PR. */
  async newStack(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    const cwd = worktreeRepoPath(runId, repoName)
    await this.sealLayer(runId, repoName, 'Seal before starting a new stack')

    const status = await this.stackStatus(runId, repoName, defaultBranch)
    const baseSha = await this.stackBaseSha(cwd, runId, repoName, 1, defaultBranch)
    const address = { stack: Math.max(...status.stacks.map((entry) => entry.stack)) + 1, layer: 1 }
    const branch = branchForLayer(runId, repoName, address)

    const tipSha = await this.git(
      cwd,
      [
        `git checkout -q -B ${shellQuote(branch)} ${shellQuote(baseSha)}`,
        `git config ${shellQuote(`branch.${branch}.${BASE_CONFIG_KEY}`)} ${shellQuote(baseSha)}`,
        recordLayerMetaCommand(branch, 1, defaultBranch),
        'git rev-parse HEAD',
      ].join(' && '),
    )

    return { ...address, branch, parentBranch: defaultBranch, tipSha: tipSha.trim() }
  }

  async checkoutLayer(
    runId: string,
    repoName: string,
    address: LayerAddress,
    defaultBranch: string,
  ): Promise<StackStatus> {
    const cwd = worktreeRepoPath(runId, repoName)
    const branch = branchForLayer(runId, repoName, address)

    const exists = await this.tryGit(
      cwd,
      `git rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}`,
    )

    if (!exists) {
      throw new Error(`Stack ${address.stack} layer ${address.layer} does not exist in ${repoName}`)
    }

    await this.sealLayer(runId, repoName, 'Seal before switching layer')
    await this.git(cwd, `git checkout -q ${shellQuote(branch)}`)

    return this.stackStatus(runId, repoName, defaultBranch)
  }
}
