import { useEffect, useRef, useState, type ClipboardEvent } from 'react'

import { pasteAttachments } from './paste-attachments'

/** Keep files local until the session and its first task can be created together. */
export function useStartAttachments() {
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const result = pasteAttachments(
      files,
      [...event.clipboardData.files],
      event.clipboardData.getData('text/plain').length > 0,
    )

    if (result.takeOver) {
      event.preventDefault()
    }

    setError(result.error)

    if (result.files !== files) {
      setFiles([...result.files])
    }
  }

  return {
    files,
    error,
    onPaste,
    remove: (index: number) => {
      setFiles((current) => current.filter((_, i) => i !== index))
      setError(null)
    },
  }
}

export function StartAttachments({
  files,
  remove,
}: {
  files: readonly File[]
  remove: (index: number) => void
}) {
  return files.length > 0 ? (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((file, index) => (
        <Preview key={index} file={file} remove={() => remove(index)} />
      ))}
    </ul>
  ) : null
}

function Preview({ file, remove }: { file: File; remove: () => void }) {
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => {
    if (!file.type.startsWith('image/')) {
      return
    }

    const url = URL.createObjectURL(file)

    if (image.current) {
      image.current.src = url
    }

    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <li className="bg-secondary/60 flex max-w-56 items-center gap-2 rounded-lg border p-1.5 text-xs">
      {file.type.startsWith('image/') ? (
        <img ref={image} alt="" className="size-10 rounded object-cover" />
      ) : null}
      <span className="truncate">{file.name}</span>
      <button
        type="button"
        onClick={remove}
        aria-label={`Remove ${file.name}`}
        className="hover:bg-accent shrink-0 rounded px-1"
      >
        ×
      </button>
    </li>
  )
}
