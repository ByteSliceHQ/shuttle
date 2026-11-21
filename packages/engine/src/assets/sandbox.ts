import { z } from 'zod'

import { shellQuote } from '@shuttle/sandbox/exec-argv'

import type { SessionSandboxStub } from '../env'
import {
  MAX_ASSET_BYTES,
  assetKind,
  cleanAssetName,
  formatBytes,
  getAsset,
  mediaTypeOfName,
  putAsset,
  type AssetRef,
} from './store'

/**
 * How a session's media meets its sandbox. Files people attach are copied in so that every
 * agent can open them by path, whatever it runs on; files agents want to show are read out.
 * Both live beside the session's worktree, never inside it, so they are not part of its changes.
 */
function sessionFilesRoot(runId: string): string {
  return `/workspace/.shuttle/${runId}`
}

/** Where a vendor agent leaves files it wants the people in the session to see. */
export function shareDirectory(runId: string): string {
  return `${sessionFilesRoot(runId)}/share`
}

/** Where an attached file is saved in the sandbox. Stable, so it can be named before it exists. */
export function attachmentPath(runId: string, asset: Pick<AssetRef, 'id' | 'name'>): string {
  const name = cleanAssetName(asset.name).replaceAll(/[^A-Za-z0-9._-]/g, '_')

  return `${sessionFilesRoot(runId)}/attachments/${asset.id.slice(4, 12)}-${name}`
}

/** What an agent is told about the files attached to a message, after the message's own text. */
export function attachmentManifest(runId: string, attachments: readonly AssetRef[]): string {
  if (attachments.length === 0) {
    return ''
  }

  const lines = attachments.map(
    (asset) =>
      `- ${asset.name} (${asset.mediaType}, ${formatBytes(asset.size)}): ${attachmentPath(runId, asset)}`,
  )

  return `Attached files, saved in the sandbox:\n${lines.join('\n')}`
}

export function withAttachmentManifest(
  text: string,
  runId: string,
  attachments: readonly AssetRef[] | undefined,
): string {
  const manifest = attachmentManifest(runId, attachments ?? [])

  return [text, manifest].filter(Boolean).join('\n\n')
}

type StagingSandbox = Pick<SessionSandboxStub, 'writeBytes'>
interface StagingStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: string[]): Promise<void>
}

const StagedIdsSchema = z.array(z.string())

/**
 * Copies attached files into the sandbox, once per file and sandbox. A file that cannot be
 * copied is skipped: the turn still runs, and the agent finds the path missing.
 */
export async function stageAttachments(input: {
  readonly bucket: R2Bucket
  readonly sandbox: StagingSandbox
  readonly sandboxName: string
  readonly storage: StagingStorage
  readonly runId: string
  readonly attachments: readonly Pick<AssetRef, 'id' | 'name'>[]
}): Promise<void> {
  if (input.attachments.length === 0) {
    return
  }

  const key = `shuttle:staged-assets:${input.sandboxName}`
  const stored = StagedIdsSchema.safeParse(await input.storage.get(key))
  const staged = new Set(stored.success ? stored.data : [])
  let changed = false

  for (const attachment of input.attachments) {
    if (staged.has(attachment.id)) {
      continue
    }

    try {
      const found = await getAsset(input.bucket, input.runId, attachment.id)

      if (!found) {
        continue
      }

      await input.sandbox.writeBytes(
        attachmentPath(input.runId, found.ref),
        new Uint8Array(await found.object.arrayBuffer()),
      )

      staged.add(attachment.id)
      changed = true
    } catch {
      // Tried again on the next turn.
    }
  }

  if (changed) {
    await input.storage.put(key, [...staged])
  }
}

export type ShareResult =
  | { readonly ok: true; readonly asset: AssetRef & { readonly kind: string } }
  | { readonly ok: false; readonly error: string }

type SharingSandbox = Pick<SessionSandboxStub, 'readBytes'>

/** Stores a file from the sandbox as session media, so it can be shown to the people in it. */
export async function shareSandboxFile(input: {
  readonly bucket: R2Bucket | undefined
  readonly sandbox: SharingSandbox
  readonly runId: string
  readonly path: string
  readonly cwd?: string
  readonly name?: string
  /** The agent thread sharing the file. */
  readonly sharedBy: string
}): Promise<ShareResult> {
  if (!input.bucket) {
    return {
      ok: false,
      error: 'File storage is not set up for this Shuttle, so files cannot be shared.',
    }
  }

  const { bytes, size } = await input.sandbox.readBytes(input.path, MAX_ASSET_BYTES, input.cwd)

  if (!bytes) {
    return {
      ok: false,
      error:
        size === null
          ? `${input.path} does not exist or is not a file.`
          : `${input.path} is ${formatBytes(size)}; files can be up to ${formatBytes(MAX_ASSET_BYTES)}.`,
    }
  }

  if (bytes.byteLength === 0) {
    return { ok: false, error: `${input.path} is empty.` }
  }

  const name = cleanAssetName(input.name ?? input.path)
  const mediaType = mediaTypeOfName(name)

  const asset = await putAsset(input.bucket, input.runId, {
    name,
    mediaType,
    body: bytes,
    source: 'agent',
    createdBy: input.sharedBy,
  })

  return { ok: true, asset: { ...asset, kind: assetKind(mediaType) } }
}

type CollectingSandbox = Pick<SessionSandboxStub, 'readBytes' | 'exec'>

/**
 * Shares every file a vendor agent left in the session's share directory, then clears them so
 * each is shared once. Returns one result per file, in name order.
 */
export async function collectSharedFiles(input: {
  readonly bucket: R2Bucket | undefined
  readonly sandbox: CollectingSandbox
  readonly runId: string
  readonly sharedBy: string
}): Promise<{ path: string; result: ShareResult }[]> {
  const directory = shareDirectory(input.runId)

  const listed = await input.sandbox.exec(
    `[ -d ${shellQuote(directory)} ] && find ${shellQuote(directory)} -maxdepth 1 -type f ! -name '.*' | sort | head -20`,
    { timeoutMs: 15_000 },
  )

  const paths = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${directory}/`))

  const shared: { path: string; result: ShareResult }[] = []

  for (const path of paths) {
    shared.push({ path, result: await shareSandboxFile({ ...input, path }) })
  }

  if (paths.length > 0) {
    await input.sandbox.exec(`rm -f -- ${paths.map(shellQuote).join(' ')}`, { timeoutMs: 15_000 })
  }

  return shared
}

/** Standing instructions that tell a vendor agent how to show a file to the people in the session. */
export function shareInstructions(runId: string): string {
  return [
    `To show the people in this session an image, video, audio clip, PDF or other file you made, copy it into ${shareDirectory(runId)} (create the directory if needed). Every file there is shown in the conversation when your turn ends, then removed from that directory. Do this for things worth looking at, such as a screenshot of the result, not for source files.`,
    'Files people attach to their messages are saved in the sandbox; each message lists their paths. Open them from those paths.',
  ].join('\n')
}
