import { useEffect, useRef, useState, type ClipboardEvent } from 'react'

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '@/lib/media'

/** Keep files local until the session and its first task can be created together. */
export function useStartAttachments() {
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files]

    if (!pasted.length) {
      return
    }

    event.preventDefault()
    const next = [...files, ...pasted]

    if (
      next.length > MAX_ATTACHMENTS ||
      next.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_BYTES - 64 * 1024 ||
      next.some((file) => !file.size)
    ) {
      setError('Attach up to 10 nonempty files, totaling less than 50 MB.')
      return
    }

    setError(null)
    setFiles(next)
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
  return files.length ? (
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
