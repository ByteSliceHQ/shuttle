import type * as EditModule from '@pierre/diffs/edit'
import { File as CodeFile, EditProvider, MultiFileDiff, PatchDiff } from '@pierre/diffs/react'
import type { EditorFactory } from '@pierre/diffs/react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileCode2, FileQuestion, Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api, statusOf } from '@/api/client'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { cn } from '@/lib/cn'
import {
  MAX_DIAGNOSTICS_CHARS,
  type ChangeStatus,
  type DiagnosticSeverity,
  type FileDiagnostic,
  type FileDiagnostics,
  type SandboxFile,
} from '@shuttle/api'

import { FILE_OPTIONS, SURFACE_STYLE } from './diff-style'
import { invalidateWorktree, patchOf } from './sandbox'

/**
 * One file from the workspace: its contents, or what the session changed in it, drawn by
 * Pierre's Diffs. A file can be edited in place between agent turns; saving writes it to the
 * workspace, and is refused if the file changed underneath the edit.
 *
 * Give it the file's path as its `key`, so each file starts with its own view and edit state.
 */

type FileView = 'diff' | 'file'
type DiffStyle = 'unified' | 'split'

/** Why a file cannot be edited right now, in words for the person looking at it. Null when it can. */
export type EditBlock = string | null

const STATUS_LABEL: Record<ChangeStatus, string> = { A: 'Added', M: 'Modified', D: 'Deleted' }

const STATUS_CLASS: Record<ChangeStatus, string> = {
  A: 'text-status-completed',
  M: 'text-status-waiting',
  D: 'text-destructive',
}

/** The editor is loaded the first time someone edits, and kept for the rest of the visit. */
let editorModule: typeof EditModule | null = null

const createEditor: EditorFactory<undefined, undefined> = (type, options, key) => {
  if (!editorModule) {
    throw new Error('The editor has not loaded yet')
  }

  return new editorModule.Editor(type, options, key)
}

/** How long after the last keystroke an edit is sent to the language server. */
const CHECK_AFTER_TYPING_MS = 350

/** How long to wait before asking a language server that was still starting again. */
const CHECK_AGAIN_MS = 2000

const SEVERITY_CLASS: Record<DiagnosticSeverity, string> = {
  error: 'text-destructive',
  warning: 'text-status-waiting',
  info: 'text-muted-foreground',
  hint: 'text-muted-foreground',
}

/** Problems worth a line of their own under the code. Hints stay out of the way. */
const SHOWN_INLINE = new Set<DiagnosticSeverity>(['error', 'warning'])

/** `TS2322`, or whatever the server calls the rule. */
function diagnosticCode(diagnostic: FileDiagnostic): string | null {
  if (!diagnostic.code) {
    return null
  }

  return (diagnostic.source === 'ts' || diagnostic.source === 'typescript') &&
    /^\d+$/.test(diagnostic.code)
    ? `TS${diagnostic.code}`
    : diagnostic.code
}

/** The editor's squiggles: one per problem, with the message shown on hover. */
function toMarkers(diagnostics: readonly FileDiagnostic[]): EditModule.Marker[] {
  return diagnostics.map((diagnostic) => {
    const code = diagnosticCode(diagnostic)

    return {
      start: { line: diagnostic.line - 1, character: diagnostic.column - 1 },
      end: { line: diagnostic.endLine - 1, character: diagnostic.endColumn - 1 },
      severity: diagnostic.severity,
      message: code ? `${diagnostic.message} (${code})` : diagnostic.message,
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
    }
  })
}

/** Problems grouped under the line they start on, for the read-only views. */
function byLine(diagnostics: readonly FileDiagnostic[]): Map<number, FileDiagnostic[]> {
  const lines = new Map<number, FileDiagnostic[]>()

  for (const diagnostic of diagnostics) {
    if (SHOWN_INLINE.has(diagnostic.severity)) {
      lines.set(diagnostic.line, [...(lines.get(diagnostic.line) ?? []), diagnostic])
    }
  }

  return lines
}

function countLabel(diagnostics: readonly FileDiagnostic[]): string | null {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length

  const parts = [
    errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : null,
    warnings > 0 ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : null,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(', ') : null
}

/** The problems on one line, drawn under it. */
function LineProblems({ problems }: { problems: readonly FileDiagnostic[] }) {
  return (
    <div className="bg-muted/40 border-border/60 border-y px-3 py-1 font-sans text-[11px] leading-4">
      {problems.map((problem) => (
        <div
          key={`${problem.column}:${problem.code ?? ''}:${problem.message}`}
          className="flex items-baseline gap-2"
        >
          <span className={cn('shrink-0 font-medium', SEVERITY_CLASS[problem.severity])}>
            {problem.severity}
          </span>
          <span className="text-foreground min-w-0 whitespace-pre-wrap">{problem.message}</span>
          {diagnosticCode(problem) ? (
            <span className="text-muted-foreground shrink-0">{diagnosticCode(problem)}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

interface Current {
  readonly content: string
  readonly binary: boolean
  readonly truncated: boolean
}

/** The file as it is now. `missing` when it is gone, null until that is known. */
function currentOf(file: SandboxFile | undefined, gone: boolean): Current | 'missing' | null {
  if (gone || file?.content === null) {
    return 'missing'
  }

  return file
    ? { content: file.content, binary: Boolean(file.binary), truncated: Boolean(file.truncated) }
    : null
}

/** A language server's answer, once it has one. It has none while it is still starting. */
function settled(answer: FileDiagnostics | undefined): FileDiagnostics | undefined {
  return answer?.status === 'pending' ? undefined : answer
}

/** A language server that is still starting is asked again shortly. */
const askAgainWhileStarting = (query: { state: { data?: { status: string } } }) =>
  query.state.data?.status === 'pending' ? CHECK_AGAIN_MS : false

export default function FilePane({
  runId,
  path,
  status,
  editBlock,
  onDirtyChange,
}: {
  runId: string
  /** `<repository>/<path>`. */
  path: string
  /** How the session changed this file, if it did. */
  status: ChangeStatus | undefined
  editBlock: EditBlock
  /** Told when there is an unsaved edit, and when there no longer is. */
  onDirtyChange: (dirty: boolean) => void
}) {
  const name = path.split('/').pop() ?? path
  const queryClient = useQueryClient()
  const [chosenView, setChosenView] = useState<FileView>('diff')
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const draft = useRef<string | null>(null)
  const decision = useRef<'accept' | 'reject'>('reject')
  /** The editor's unsaved text as of a moment after typing stopped. Null until something is typed. */
  const [typed, setTyped] = useState<string | null>(null)
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editor = useRef<EditModule.Editor<'file', FileDiagnostic[], undefined> | null>(null)

  useEffect(() => () => clearTimeout(typing.current), [])

  // A deleted file has only its changes to show, an unchanged one only itself, and an edit
  // happens on the whole file.
  const view: FileView = editing || !status ? 'file' : status === 'D' ? 'diff' : chosenView

  // Each of these is read again whenever the tab shows the file, and whenever the session's
  // events say its files may have changed (see `ArtifactPane`).
  const fileQuery = useQuery(
    api.sandbox.file.queryOptions({
      input: { id: runId, path },
      staleTime: 0,
      // The editor owns the text while someone is typing; reloading would pull it out from
      // under them.
      enabled: !editing,
    }),
  )

  // A deleted file is expected to be gone.
  const current = currentOf(fileQuery.data, statusOf(fileQuery.error) === 404)

  const baseQuery = useQuery(
    api.sandbox.file.queryOptions({
      input: { id: runId, path, version: 'base' },
      staleTime: 0,
      enabled: view === 'diff',
    }),
  )

  // Older saved copies do not record where the session started. Without the starting point,
  // the patch still says what changed.
  const baseUnknown = statusOf(baseQuery.error) === 404

  const patchQuery = useQuery(
    api.sandbox.diff.queryOptions({
      input: { id: runId, path },
      staleTime: 0,
      enabled: view === 'diff' && baseUnknown,
      select: patchOf,
    }),
  )

  /** `unknown` when the session's starting point is not recorded: the patch is shown instead. */
  const base: { content: string | null } | 'unknown' | null = baseUnknown
    ? patchQuery.data === undefined
      ? null
      : 'unknown'
    : (baseQuery.data ?? null)

  const patch = patchQuery.data ?? null

  const error =
    (current === 'missing' ? null : fileQuery.error) ??
    (view === 'diff' && !base ? (baseUnknown ? patchQuery.error : baseQuery.error) : null)

  const content = current && current !== 'missing' ? current.content : null
  const checkable = content !== null && !(current !== 'missing' && current?.binary)

  // Ask the language server about the file: as saved while reading, as typed while editing.
  const savedCheck = useQuery(
    api.sandbox.diagnostics.saved.queryOptions({
      input: { id: runId, path },
      staleTime: 0,
      enabled: checkable && typed === null,
      refetchInterval: askAgainWhileStarting,
    }),
  )

  // Keyed on the text it is a check of. An answer is kept under the text it was for and only
  // the latest text's answer is read, so a slow answer to an earlier keystroke is never shown
  // over a later one; the request for text that has been typed over is dropped.
  const draftCheck = useQuery(
    api.sandbox.diagnostics.draft.queryOptions({
      input: { params: { id: runId }, query: { path }, body: { content: typed ?? '' } },
      enabled: checkable && editing && typed !== null && typed.length <= MAX_DIAGNOSTICS_CHARS,
      // The problems found in the text before stay until this text's are known.
      placeholderData: keepPreviousData,
      // No earlier draft is worth keeping once it has been typed over.
      gcTime: 0,
      refetchInterval: askAgainWhileStarting,
    }),
  )

  // Until the first check of an edit answers, what was found in the saved file still stands.
  const checked =
    (typed === null ? undefined : settled(draftCheck.data)) ?? settled(savedCheck.data)

  const diagnostics = useMemo(
    () => (checkable && checked?.status === 'ok' ? checked.diagnostics : []),
    [checkable, checked],
  )

  // While editing, problems are squiggles in the editor, which keeps them in place as text moves.
  const markers = useRef<EditModule.Marker[]>([])

  useEffect(() => {
    markers.current = toMarkers(diagnostics)

    if (editing) {
      editor.current?.setMarkers(markers.current)
    }
  }, [editing, diagnostics])

  const editorOptions = useMemo(
    () => ({
      onAttach: (attached: EditModule.Editor<'file', FileDiagnostic[], undefined>) => {
        editor.current = attached
        // The editor attaches after the problems are known, so it is given them here too.
        attached.setMarkers(markers.current)
      },
    }),
    [],
  )

  // While reading, they are lines under the code. The editor owns annotations during an edit.
  const fileAnnotations = useMemo(
    () =>
      editing
        ? undefined
        : [...byLine(diagnostics)].map(([lineNumber, metadata]) => ({ lineNumber, metadata })),
    [editing, diagnostics],
  )

  const diffAnnotations = useMemo(
    () =>
      [...byLine(diagnostics)].map(([lineNumber, metadata]) => ({
        side: 'additions' as const,
        lineNumber,
        metadata,
      })),
    [diagnostics],
  )

  const problemCount = countLabel(diagnostics)

  const file = useMemo(
    () => (content === null ? null : { name, contents: content }),
    [name, content],
  )

  const oldFile = useMemo(
    () =>
      base && base !== 'unknown' && base.content !== null ? { name, contents: base.content } : null,
    [name, base],
  )

  const diffOptions = useMemo(() => ({ ...FILE_OPTIONS, diffStyle }), [diffStyle])

  // The cache is brought up to date here, so it happens even if the file's tab has been left by
  // the time the save answers. Leaving the editor is the save button's own business, below.
  const write = useMutation(
    api.sandbox.write.mutationOptions({
      onSuccess: (_saved, sent) => {
        // What was saved is the file now; the editor's text is kept as it is.
        queryClient.setQueryData(
          api.sandbox.file.queryKey({ input: { id: runId, path } }),
          (was) => was && { ...was, content: sent.content },
        )

        // If the last check was of this very text, it is what the saved file's check will say.
        const last = settled(draftCheck.data)

        if (last && typed === sent.content && !draftCheck.isPlaceholderData) {
          queryClient.setQueryData(
            api.sandbox.diagnostics.saved.queryKey({ input: { id: runId, path } }),
            last,
          )
        }

        // The workspace's list of changes, this file's diff and its problems follow the save.
        void invalidateWorktree(queryClient, runId)
      },
    }),
  )

  const saving = write.isPending
  const saveError = write.error?.message ?? editorError

  function stopEditing(outcome: 'accept' | 'reject') {
    clearTimeout(typing.current)
    decision.current = outcome
    draft.current = null
    editor.current = null
    setTyped(null)
    setEditing(false)
    setDirty(false)
    setEditorError(null)
    write.reset()
    onDirtyChange(false)
  }

  function save() {
    const next = draft.current

    if (saving) {
      return
    }

    if (content === null || next === null || next === content) {
      stopEditing('reject')

      return
    }

    // `expected` is the text the edit started from: the save is refused if the file has
    // changed since, and while agents are working.
    write.mutate(
      { id: runId, path, content: next, expected: content },
      { onSuccess: () => stopEditing('accept') },
    )
  }

  const startEditing = () => {
    setEditorError(null)
    write.reset()

    void import('@pierre/diffs/edit')
      .then((loaded) => {
        editorModule = loaded
        decision.current = 'reject'
        setEditing(true)
      })
      .catch(() => setEditorError('The editor could not be loaded'))
  }

  if (error && (!current || (view === 'diff' && !base))) {
    return (
      <EmptyState icon={<FileQuestion />} title="Could not open file">
        {error.message}
      </EmptyState>
    )
  }

  if (!current || (view === 'diff' && !base)) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading…
      </div>
    )
  }

  if (current !== 'missing' && current.binary) {
    return (
      <EmptyState icon={<FileCode2 />} title="Binary file">
        {name} cannot be shown as text.
      </EmptyState>
    )
  }

  if (current === 'missing' && view === 'file') {
    return (
      <EmptyState icon={<FileQuestion />} title="Could not open file">
        {path} is not in the session's files any more.
      </EmptyState>
    )
  }

  const truncated = current !== 'missing' && current.truncated

  const blocked =
    editBlock ??
    (status === 'D' ? 'Deleted files cannot be edited.' : null) ??
    (truncated ? 'This file is too large to edit here.' : null)

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          save()
        }
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2.5 text-[11px]">
        {status ? (
          <span className={cn('shrink-0 font-medium', STATUS_CLASS[status])}>
            {STATUS_LABEL[status]}
          </span>
        ) : null}
        {editing ? (
          <span className="text-muted-foreground min-w-0 truncate" role="status">
            {saveError ?? (dirty ? 'Unsaved changes' : 'Editing')}
          </span>
        ) : saveError ? (
          <span className="text-destructive min-w-0 truncate" role="alert">
            {saveError}
          </span>
        ) : blocked ? (
          <span className="text-muted-foreground min-w-0 truncate" title={blocked}>
            {blocked}
          </span>
        ) : null}
        {problemCount ? (
          <span className="text-destructive shrink-0" role="status">
            {problemCount}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[11px]"
                disabled={saving}
                onClick={() => stopEditing('reject')}
              >
                Cancel
              </Button>
              <Button size="sm" className="h-5 px-2 text-[11px]" disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              {view === 'diff' ? (
                <Switch
                  label="Layout"
                  value={diffStyle}
                  onChange={setDiffStyle}
                  options={[
                    { value: 'unified', label: 'Unified' },
                    { value: 'split', label: 'Split' },
                  ]}
                />
              ) : null}
              {status && status !== 'D' ? (
                <Switch
                  label="Show"
                  value={view}
                  onChange={setChosenView}
                  options={[
                    { value: 'diff', label: 'Changes' },
                    { value: 'file', label: 'File' },
                  ]}
                />
              ) : null}
              {blocked ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[11px]"
                  onClick={startEditing}
                >
                  <Pencil />
                  Edit
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" style={SURFACE_STYLE}>
        <EditProvider createEditor={createEditor}>
          {view === 'file' && file ? (
            <CodeFile
              file={file}
              options={FILE_OPTIONS}
              edit={editing}
              editorOptions={editorOptions}
              lineAnnotations={fileAnnotations}
              renderAnnotation={(annotation) => <LineProblems problems={annotation.metadata} />}
              onEditChange={(event) => {
                draft.current = event.file.contents

                // The language server is asked a moment after typing stops, not on every key.
                clearTimeout(typing.current)

                typing.current = setTimeout(() => setTyped(draft.current), CHECK_AFTER_TYPING_MS)

                const changed = event.file.contents !== content

                if (changed !== dirty) {
                  setDirty(changed)
                  onDirtyChange(changed)
                }
              }}
              onEditComplete={() => decision.current}
            />
          ) : base === 'unknown' ? (
            patch?.trim() ? (
              <PatchDiff patch={patch} options={diffOptions} />
            ) : (
              <EmptyState icon={<FileCode2 />} title="No changes">
                This file is the same as when the session started.
              </EmptyState>
            )
          ) : // The component takes a file on each side, or exactly one missing side.
          oldFile && file ? (
            <MultiFileDiff
              oldFile={oldFile}
              newFile={file}
              options={diffOptions}
              lineAnnotations={diffAnnotations}
              renderAnnotation={(annotation) => <LineProblems problems={annotation.metadata} />}
            />
          ) : file ? (
            <MultiFileDiff
              oldFile={null}
              newFile={file}
              options={diffOptions}
              lineAnnotations={diffAnnotations}
              renderAnnotation={(annotation) => <LineProblems problems={annotation.metadata} />}
            />
          ) : oldFile ? (
            <MultiFileDiff oldFile={oldFile} newFile={null} options={diffOptions} />
          ) : (
            <EmptyState icon={<FileCode2 />} title="No changes">
              This file is the same as when the session started.
            </EmptyState>
          )}
        </EditProvider>
        {truncated ? (
          <p className="text-muted-foreground px-4 py-2 text-[11px]">
            This file is too large to show in full. The rest is cut off.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** A two-way switch drawn as one control. */
function Switch<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly { readonly value: T; readonly label: string }[]
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-md border p-px">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'focus-visible:ring-ring/50 flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] outline-none focus-visible:ring-2',
            option.value === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
