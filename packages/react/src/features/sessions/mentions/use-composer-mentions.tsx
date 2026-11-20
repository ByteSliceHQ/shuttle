import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react'

import { fitPastedMentions, mentionClipboard, readMentionClipboard } from './clipboard'
import { MentionHighlights } from './highlights'
import { MentionMenu, mentionOptionId, useMentionOptions, type MentionOption } from './menu'
import { labelsInUse, pickOf, picksIn, type MentionPick } from './picks'
import { findMentionQuery, insertMention } from './search'
import { mentionToken, uniqueMentionLabel } from './tokens'

/**
 * Everything `@` does in the message box: the menu and moving through it, the picks and their
 * highlights, and copying and pasting text with mentions in it. The message box keeps its text
 * and hands this the text and a way to change it.
 */

export interface ComposerMentions {
  /** The menu, to draw above the text box. Null while it is closed. */
  readonly menu: ReactNode
  /** The highlight layer, to draw behind the text box in the same positioned box. */
  readonly highlights: ReactNode
  /** Props for the text box: its combobox role, and its caret, scroll, copy and cut handlers. */
  readonly inputProps: TextareaHTMLAttributes<HTMLTextAreaElement>
  /** Call from the text box's change handler, after taking the new text. */
  readonly onTextChange: (value: string, caret: number) => void
  /** Call first in the text box's key handler. True when the menu used the key. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Call from the text box's paste handler. Pastes text with mentions; leaves other text alone. */
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /** The picks still in `text`, for sending it. The box starts again with none. */
  readonly take: (text: string) => MentionPick[]
  /** Puts picks back, as when a message could not be sent and its text is handed back. */
  readonly restore: (picks: readonly MentionPick[]) => void
}

export function useComposerMentions({
  runId,
  text,
  setText,
  inputRef,
  active,
  editable,
  agents,
  onPickAgent,
}: {
  runId: string
  text: string
  setText: (text: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** Whether the menu may open: the text box has the focus and can be written in. */
  active: boolean
  /** Whether cutting may change the text. */
  editable: boolean
  /** Team members the message can be handed to. Empty when there is no one to hand it to. */
  agents: readonly { id: string; label: string }[]
  /** Called when a team member is picked; the `@…` typed to find them is taken out. */
  onPickAgent: (id: string) => void
}): ComposerMentions {
  /** Where the caret is in the text, for telling whether it is in an `@…`. */
  const [caret, setCaret] = useState(0)
  const [picks, setPicks] = useState<readonly MentionPick[]>([])
  /** The `@` whose menu was closed with Escape. It stays closed until another `@` is typed. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuQuery, setMenuQuery] = useState<string | null>(null)
  /** The layer behind the text box that draws its picks highlighted, scrolled along with it. */
  const highlightRef = useRef<HTMLDivElement>(null)
  /** Where to put the caret once the text a change made is on screen. */
  const pendingCaret = useRef<number | null>(null)
  const menuId = useId()

  const typing = active ? findMentionQuery(text, caret) : null

  // A mention already picked is done with: writing on after it is not searching for another.
  const pickedHere =
    typing !== null &&
    picks.some((picked) => text.startsWith(mentionToken(picked.shown), typing.start))

  const query = typing !== null && typing.start !== dismissedAt && !pickedHere ? typing : null

  const options = useMentionOptions({
    runId,
    query: query?.query ?? '',
    open: query !== null,
    agents,
  })

  // Several words that match nothing are prose, not a search: the menu closes rather than sit
  // there saying how many files it searched.
  const open =
    query !== null &&
    (options.options.length > 0 || (options.filesNote !== null && !query.query.includes(' ')))

  // Typing more starts again from the best match.
  const currentQuery = query?.query ?? null

  if (currentQuery !== menuQuery) {
    setMenuQuery(currentQuery)
    setActiveIndex(0)
  }

  const highlighted = Math.min(activeIndex, Math.max(0, options.options.length - 1))

  useLayoutEffect(() => {
    const at = pendingCaret.current

    if (at !== null && inputRef.current) {
      pendingCaret.current = null
      inputRef.current.setSelectionRange(at, at)
    }
  })

  /** Replaces the text and puts the caret at `at` once it is on screen. */
  function replaceText(next: string, at: number) {
    pendingCaret.current = at
    setCaret(at)
    setText(next)
  }

  function pick(option: MentionOption) {
    if (query === null) {
      return
    }

    // A team member is the same choice as the steer menu's: the message is handed to them.
    if (option.kind === 'agent') {
      const end = query.start + 1 + query.query.length

      onPickAgent(option.id)
      replaceText(text.slice(0, query.start) + text.slice(end).replace(/^ /, ''), query.start)
      return
    }

    // Two sessions can share a title; each is written its own way, so each keeps its own link.
    const picked =
      option.kind === 'file'
        ? pickOf({ kind: 'file', path: option.id })
        : pickOf({
            kind: 'session',
            sessionId: option.id,
            title: option.label,
            label: uniqueMentionLabel(
              option.label,
              `session:${option.id}`,
              labelsInUse(text, picks),
            ),
          })

    const next = insertMention(text, query, mentionToken(picked.shown))

    setPicks((current) => [...current, picked])
    replaceText(next.text, next.caret)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing) {
      return false
    }

    const count = options.options.length
    const chosen = options.options[highlighted]

    if (event.key === 'Escape') {
      setDismissedAt(query.start)
    } else if (count > 0 && event.key === 'ArrowDown') {
      setActiveIndex((highlighted + 1) % count)
    } else if (count > 0 && event.key === 'ArrowUp') {
      setActiveIndex((highlighted - 1 + count) % count)
    } else if (chosen && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      pick(chosen)
    } else {
      return false
    }

    event.preventDefault()

    return true
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const mentioned = readMentionClipboard(
      event.clipboardData.getData('text/html'),
      event.clipboardData.getData('text/plain'),
    )

    if (mentioned === null || mentioned.references.length === 0) {
      return
    }

    event.preventDefault()

    const box = event.currentTarget
    const fitted = fitPastedMentions(mentioned, labelsInUse(text, picks))

    setPicks((current) => [...current, ...fitted.references.map(pickOf)])

    replaceText(
      text.slice(0, box.selectionStart) + fitted.text + text.slice(box.selectionEnd),
      box.selectionStart + fitted.text.length,
    )
  }

  /** Copying or cutting part of the text keeps the mentions in it, for pasting somewhere else. */
  function onCopy(event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) {
    const box = event.currentTarget
    const selected = text.slice(box.selectionStart, box.selectionEnd)

    const { plain, html } = mentionClipboard(
      selected,
      picks.map((picked) => picked.shown),
    )

    // With no mentions in it, the text box copies as it always does.
    if (html === null) {
      return
    }

    event.preventDefault()
    event.clipboardData.setData('text/plain', plain)
    event.clipboardData.setData('text/html', html)

    if (cut && editable) {
      replaceText(
        text.slice(0, box.selectionStart) + text.slice(box.selectionEnd),
        box.selectionStart,
      )
    }
  }

  return {
    menu: open ? (
      <MentionMenu
        id={menuId}
        groups={options.groups}
        activeIndex={highlighted}
        filesNote={options.filesNote}
        onPick={pick}
        onHover={setActiveIndex}
      />
    ) : null,
    highlights: <MentionHighlights ref={highlightRef} text={text} picks={picks} />,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      'aria-activedescendant':
        open && options.options.length > 0 ? mentionOptionId(menuId, highlighted) : undefined,
      onSelect: (event) => setCaret(event.currentTarget.selectionStart),
      onScroll: (event) => {
        if (highlightRef.current) {
          highlightRef.current.scrollTop = event.currentTarget.scrollTop
        }
      },
      onCopy: (event) => onCopy(event, false),
      onCut: (event) => onCopy(event, true),
    },
    onTextChange: (value, at) => {
      setCaret(at)

      // A new `@` opens the menu again.
      if (dismissedAt !== null && value.charAt(dismissedAt) !== '@') {
        setDismissedAt(null)
      }
    },
    onKeyDown,
    onPaste,
    take: (sent) => {
      const kept = picksIn(sent, picks)

      setPicks([])

      return kept
    },
    restore: (returned) => setPicks((current) => [...current, ...returned]),
  }
}
