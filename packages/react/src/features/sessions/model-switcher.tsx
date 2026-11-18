import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

import type {
  HarnessId,
  Team,
  VendorHarnessId,
  VendorModel,
  VendorModelChoice,
  VendorModelChoices,
} from '@shuttle/api'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/cn'
import { useApi } from '../../shuttle'
import {
  DEFAULT_OPENROUTER_MODEL,
  formatContextWindow,
  getOpenRouterModel,
  isOpenRouterModelId,
  MODEL_GROUP_LABELS,
  MODEL_TAG_LABELS,
  MODEL_TAG_TONES,
  modelsByGroup,
  OPENROUTER_MODELS,
  type ModelTag,
  type OpenRouterModel,
  type OpenRouterModelId,
} from './llm-models'
import { matchesModelQuery } from './model-search'
import {
  chosenEffort,
  chosenModelId,
  chosenVendorModel,
  effortLabel,
  modelSections,
  sectionLabel,
  vendorChoiceLabel,
  withVendorModel,
  type ModelSection,
} from './vendor-models'

const GROUPS = ['frontier', 'fast'] as const

/** What a section's models are used for, shown under its name in the rail. */
function sectionHint(section: ModelSection): string {
  return section === 'openrouter' ? 'Conductor and workers' : 'Your subscription'
}

/** One vendor agent's models: the list once it is in, and whether it is still on its way. */
interface VendorModelList {
  readonly models: readonly VendorModel[] | undefined
  readonly loading: boolean
}

/**
 * The models each of `harnesses` offers. A list stays in the query cache, so the trigger can
 * name a model without waiting each time it mounts. A list that cannot be read is left out: the
 * picker still offers the agent's default without one.
 */
function useVendorModels(
  harnesses: readonly VendorHarnessId[],
): ReadonlyMap<VendorHarnessId, VendorModelList> {
  const api = useApi()

  return useQueries({
    queries: harnesses.map((harness) =>
      api.connections.models.queryOptions({ input: { harness } }),
    ),
    combine: (results) => {
      const lists = new Map<VendorHarnessId, VendorModelList>()

      harnesses.forEach((harness, index) => {
        const result = results[index]

        if (result !== undefined) {
          lists.set(harness, { models: result.data?.models, loading: result.isPending })
        }
      })

      return lists
    },
  })
}

/**
 * Which row the arrow keys or pointer are on. Until one moves it, that is the resting row (the
 * current choice); a new search starts again from the first match.
 */
function useActiveRow(query: string, count: number, resting: number) {
  const [moved, setMoved] = useState<{ query: string; index: number } | null>(null)

  const index =
    moved !== null && moved.query === query ? moved.index : query === '' ? Math.max(resting, 0) : 0

  const setActive = (next: number | null) =>
    setMoved((previous) =>
      next === null
        ? null
        : previous?.query === query && previous.index === next
          ? previous
          : { query, index: next },
    )

  return [count === 0 ? -1 : Math.min(index, count - 1), setActive] as const
}

/**
 * Picks the model for whoever does the work in a session. A session run by Codex, Claude Code,
 * or Cursor offers that agent's models; a Shuttle session offers OpenRouter's for the conductor
 * and workers, plus a section for each vendor agent on its team.
 */
export function ModelSwitcher({
  harness,
  team,
  value,
  onChange,
  vendorChoices,
  onVendorChoiceChange,
  disabled = false,
}: {
  harness: HarnessId
  team: Team
  value: OpenRouterModelId
  onChange: (model: OpenRouterModelId) => void
  vendorChoices: VendorModelChoices
  onVendorChoiceChange: (harness: VendorHarnessId, choice: VendorModelChoice) => void
  disabled?: boolean
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<ModelSection | null>(null)
  const [query, setQuery] = useState('')

  const sections = modelSections(harness, team)
  const primary = sections[0] ?? 'openrouter'
  const section = picked !== null && sections.includes(picked) ? picked : primary

  const vendorSections = sections.filter(
    (entry): entry is VendorHarnessId => entry !== 'openrouter',
  )

  const vendorModels = useVendorModels(vendorSections)

  const selected =
    getOpenRouterModel(value) ??
    getOpenRouterModel(DEFAULT_OPENROUTER_MODEL) ??
    OPENROUTER_MODELS[0]

  const summary = (entry: ModelSection): string =>
    entry === 'openrouter'
      ? selected.label
      : vendorChoiceLabel(vendorChoices[entry], vendorModels.get(entry)?.models ?? [])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (next) {
          setPicked(null)
          setQuery('')
          // What an agent offers can change with the plan, so opening the picker asks again.
          void queryClient.invalidateQueries({ queryKey: api.connections.models.key() })
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`${sectionLabel(primary)} model`}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy flex h-7 max-w-40 min-w-0 shrink items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50 sm:max-w-56"
      >
        <span className="truncate">{summary(primary)}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        side="top"
        sideOffset={8}
        className="flex w-auto max-w-[min(100vw-2rem,46rem)] gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (query !== '') {
            event.preventDefault()
            setQuery('')
          }
        }}
      >
        {sections.length > 1 ? (
          <div
            role="tablist"
            aria-label="Models for"
            aria-orientation="vertical"
            className="border-border flex w-36 shrink-0 flex-col gap-0.5 border-r p-1"
          >
            {sections.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={entry === section}
                onClick={() => {
                  setPicked(entry)
                  setQuery('')
                }}
                className={cn(
                  'flex w-full cursor-default flex-col rounded-sm px-2 py-1.5 text-left outline-none select-none',
                  entry === section
                    ? 'bg-accent text-accent-foreground'
                    : 'text-popover-foreground hover:bg-accent/50',
                )}
              >
                <span className="text-xs font-medium">{sectionLabel(entry)}</span>
                <span className="text-muted-foreground truncate text-[10px]">
                  {sectionHint(entry)}
                </span>
                <span
                  title={summary(entry)}
                  className="text-muted-foreground/80 mt-0.5 truncate text-[10px]"
                >
                  {summary(entry)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {section === 'openrouter' ? (
          <OpenRouterPane
            key={section}
            value={value}
            selected={selected}
            query={query}
            onQueryChange={setQuery}
            onSelect={(model) => {
              onChange(model)
              setOpen(false)
            }}
          />
        ) : (
          <VendorPane
            key={section}
            harness={section}
            models={vendorModels.get(section)?.models}
            loading={vendorModels.get(section)?.loading ?? false}
            choice={vendorChoices[section]}
            query={query}
            onQueryChange={setQuery}
            onChange={(choice) => onVendorChoiceChange(section, choice)}
            onClose={() => setOpen(false)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OpenRouterPane({
  value,
  selected,
  query,
  onQueryChange,
  onSelect,
}: {
  value: OpenRouterModelId
  selected: OpenRouterModel
  query: string
  onQueryChange: (query: string) => void
  onSelect: (model: OpenRouterModelId) => void
}) {
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        models: modelsByGroup(group).filter((model) =>
          matchesModelQuery(query, [model.label, model.id, model.description]),
        ),
      })).filter((entry) => entry.models.length > 0),
    [query],
  )

  const rows = groups.flatMap((entry) => entry.models)

  const [active, setActive] = useActiveRow(
    query,
    rows.length,
    rows.findIndex((model) => model.id === value),
  )

  const preview = rows[active] ?? selected

  return (
    <>
      <ModelList
        query={query}
        onQueryChange={onQueryChange}
        placeholder="Search models"
        count={rows.length}
        active={active}
        onActiveChange={setActive}
        onPick={(index) => {
          const model = rows[index]

          if (model && isOpenRouterModelId(model.id)) {
            onSelect(model.id)
          }
        }}
      >
        {groups.map(({ group, models }, groupIndex) => (
          <div key={group}>
            {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{MODEL_GROUP_LABELS[group]}</DropdownMenuLabel>
            {models.map((model) => {
              const index = rows.indexOf(model)

              return (
                <OptionRow
                  key={model.id}
                  label={model.label}
                  trailing={<ModelTags tags={model.tags} size="row" />}
                  selected={model.id === value}
                  active={index === active}
                  onActivate={() => setActive(index)}
                  onSelect={() => {
                    if (isOpenRouterModelId(model.id)) {
                      onSelect(model.id)
                    }
                  }}
                />
              )
            })}
          </div>
        ))}
      </ModelList>
      <aside className="border-border hidden w-52 shrink-0 border-l p-3 sm:block">
        <p className="text-foreground text-xs font-medium">{preview.label}</p>
        <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
          {preview.description}
        </p>
        <p className="text-muted-foreground/80 mt-2 text-[11px]">
          {formatContextWindow(preview.context)}
        </p>
        {preview.note !== undefined && preview.note !== '' ? (
          <p className="text-muted-foreground/70 mt-1 text-[11px] italic">{preview.note}</p>
        ) : null}
        <div className="mt-2.5">
          <ModelTags tags={preview.tags} size="detail" />
        </div>
      </aside>
    </>
  )
}

/** One entry in a vendor agent's list: its default, one of its models, or a model it dropped. */
interface VendorRow {
  key: string
  label: string
  hint?: string | undefined
  /** Searched by the filter: the label plus anything else worth typing. */
  keywords: readonly (string | undefined)[]
  title: string
  description: string
  id?: string | undefined
  efforts: readonly string[]
  selected: boolean
  /** What picking the row chooses. A model the agent no longer lists can't be picked again. */
  choice?: VendorModelChoice | undefined
}

/**
 * A vendor agent's models on the left, and beside them the one under the pointer or keyboard,
 * with reasoning efforts once a model that takes them is chosen.
 */
function VendorPane({
  harness,
  models,
  loading,
  choice,
  query,
  onQueryChange,
  onChange,
  onClose,
}: {
  harness: VendorHarnessId
  /** Undefined until the agent's list is in, and for good when it could not be read. */
  models: readonly VendorModel[] | undefined
  /** The list is being read for the first time. */
  loading: boolean
  choice: VendorModelChoice | undefined
  query: string
  onQueryChange: (query: string) => void
  onChange: (choice: VendorModelChoice) => void
  onClose: () => void
}) {
  const list = models ?? []
  const defaultModel = list.find((model) => model.isDefault === true)
  const choiceModel = chosenModelId(choice)
  const choiceEffort = chosenEffort(choice)
  const current = chosenVendorModel(choice, list)
  const agent = sectionLabel(harness)

  const all: VendorRow[] = [
    {
      key: ':default',
      label: 'Default',
      hint: defaultModel?.label,
      keywords: ['default', agent, defaultModel?.label],
      title: `${agent} default`,
      description: defaultModel
        ? `Whichever model ${agent} picks for your plan, currently ${defaultModel.label}.`
        : `Whichever model ${agent} picks for your plan.`,
      efforts: defaultModel?.efforts ?? [],
      selected: choiceModel === undefined,
      choice: withVendorModel(choice, undefined, defaultModel),
    },
    ...list.map((model) => ({
      key: model.id,
      label: model.label,
      keywords: [model.label, model.id, model.description],
      title: model.label,
      description: model.description,
      id: model.id,
      efforts: model.efforts,
      selected: choice?.model === model.id,
      choice: withVendorModel(choice, model, defaultModel),
    })),
    ...(choiceModel !== undefined && current === undefined
      ? [
          {
            key: ':missing',
            label: choiceModel,
            keywords: [choiceModel],
            title: choiceModel,
            description: `${agent} no longer lists this model.`,
            efforts: [],
            selected: true,
          },
        ]
      : []),
  ]

  const rows = all.filter((row) => matchesModelQuery(query, row.keywords))

  const [active, setActive] = useActiveRow(
    query,
    rows.length,
    rows.findIndex((row) => row.selected),
  )

  const preview = rows[active] ?? all.find((row) => row.selected)

  const pick = (row: VendorRow) => {
    if (row.choice) {
      onChange(row.choice)
    }

    if (row.efforts.length === 0) {
      onClose()
    }
  }

  return (
    <>
      <ModelList
        query={query}
        onQueryChange={onQueryChange}
        placeholder={`Search ${agent} models`}
        count={rows.length}
        active={active}
        onActiveChange={setActive}
        onPick={(index) => {
          const row = rows[index]

          if (row) {
            pick(row)
          }
        }}
        onPointerLeave={() => setActive(null)}
        status={
          loading ? (
            <p className="text-muted-foreground px-2 py-1.5 text-[11px]">Loading models…</p>
          ) : null
        }
      >
        {rows.map((row, index) => (
          <OptionRow
            key={row.key}
            label={row.label}
            trailing={
              row.hint !== undefined && row.hint !== '' ? (
                <span className="text-muted-foreground text-[10px]">{row.hint}</span>
              ) : null
            }
            selected={row.selected}
            active={index === active}
            onActivate={() => setActive(index)}
            onSelect={() => pick(row)}
          />
        ))}
      </ModelList>
      <aside className="border-border flex max-h-80 w-52 shrink-0 flex-col overflow-y-auto border-l p-1">
        {preview ? (
          <div className="px-2 pt-2 pb-1.5">
            <p className="text-foreground text-xs font-medium break-words">{preview.title}</p>
            {preview.description !== '' ? (
              <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                {preview.description}
              </p>
            ) : null}
            {preview.id !== undefined && preview.id !== '' ? (
              <p className="text-muted-foreground/70 mt-1.5 font-mono text-[10px] break-all">
                {preview.id}
              </p>
            ) : null}
          </div>
        ) : null}
        {preview && preview.efforts.length > 0 ? (
          preview.selected ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
              <OptionRow
                label="Default"
                trailing={
                  current?.defaultEffort !== undefined && current.defaultEffort !== '' ? (
                    <span className="text-muted-foreground text-[10px]">
                      {effortLabel(current.defaultEffort)}
                    </span>
                  ) : null
                }
                selected={choiceEffort === undefined}
                onSelect={() => {
                  onChange(choiceModel === undefined ? {} : { model: choiceModel })
                  onClose()
                }}
              />
              {preview.efforts.map((effort) => (
                <OptionRow
                  key={effort}
                  label={effortLabel(effort)}
                  selected={choiceEffort === effort}
                  onSelect={() => {
                    onChange(
                      choiceModel === undefined ? { effort } : { model: choiceModel, effort },
                    )

                    onClose()
                  }}
                />
              ))}
            </>
          ) : (
            <p className="text-muted-foreground px-2 pb-2 text-[11px] leading-relaxed">
              Reasoning: {preview.efforts.map(effortLabel).join(', ')}
            </p>
          )
        ) : null}
      </aside>
    </>
  )
}

/** Scrolls the list just enough to show the row, keeping the first group's heading visible. */
function keepInView(list: HTMLElement, row: HTMLElement, isFirst: boolean) {
  const top = row.offsetTop - 4
  const bottom = row.offsetTop + row.offsetHeight + 4

  if (isFirst) {
    list.scrollTop = 0
  } else if (top < list.scrollTop) {
    list.scrollTop = top
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight
  }
}

/** A search field over a list of models; the arrow keys and Enter work from the field. */
function ModelList({
  query,
  onQueryChange,
  placeholder,
  count,
  active,
  onActiveChange,
  onPick,
  onPointerLeave,
  status,
  children,
}: {
  query: string
  onQueryChange: (query: string) => void
  placeholder: string
  count: number
  active: number
  onActiveChange: (index: number) => void
  onPick: (index: number) => void
  onPointerLeave?: () => void
  /** Shown under the rows, such as while the list is loading. */
  status?: ReactNode
  children: ReactNode
}) {
  const columnRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [fullHeight, setFullHeight] = useState<number>()

  useEffect(() => {
    // Focusing on touch screens would raise the keyboard over the list.
    if (window.matchMedia('(pointer: fine)').matches) {
      inputRef.current?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('[data-active="true"]')

    if (list && row) {
      keepInView(list, row, active === 0)
    }
  }, [active])

  const changeQuery = (next: string) => {
    // The menu grows up from the composer, so a shrinking list would pull the field down.
    if (query === '' && next !== '') {
      setFullHeight(columnRef.current?.offsetHeight)
    }

    listRef.current?.scrollTo({ top: 0 })
    onQueryChange(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      return
    }

    // The menu would otherwise take typed letters as typeahead and swallow Tab.
    event.stopPropagation()

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      if (count > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1

        onActiveChange(Math.min(Math.max(active + step, 0), count - 1))
      }
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault()
      onPick(active)
    }
  }

  return (
    <div
      ref={columnRef}
      style={
        query !== '' && fullHeight !== undefined && fullHeight > 0
          ? { minHeight: fullHeight }
          : undefined
      }
      className="flex w-60 shrink-0 flex-col sm:w-72"
    >
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="text-foreground placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        {query !== '' ? (
          <button
            type="button"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => changeQuery('')}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mr-1 flex size-5 shrink-0 cursor-default items-center justify-center rounded-sm outline-none focus-visible:ring-[3px]"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      <div
        ref={listRef}
        onPointerLeave={onPointerLeave}
        className="relative flex max-h-80 min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-1"
      >
        {count > 0 ? (
          children
        ) : (
          <p className="text-muted-foreground px-2 py-6 text-center text-[11px] break-words">
            No models match “{query}”
          </p>
        )}
        {status}
      </div>
    </div>
  )
}

/**
 * A pickable row. Rows in a searchable list are highlighted by the list (`active`), so the
 * keyboard and pointer share one highlight; other rows highlight on hover.
 */
function OptionRow({
  label,
  trailing,
  selected,
  active,
  onActivate,
  onSelect,
}: {
  label: string
  trailing?: ReactNode
  selected: boolean
  active?: boolean
  onActivate?: () => void
  onSelect?: () => void
}) {
  const onPointerMove = (event: PointerEvent) => {
    // Rows scrolling under a still pointer report no movement, and shouldn't steal the highlight.
    if (event.movementX !== 0 || event.movementY !== 0) {
      onActivate?.()
    }
  }

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-active={active}
      onPointerMove={onActivate ? onPointerMove : undefined}
      onFocus={onActivate}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-left text-xs outline-none select-none',
        active === undefined
          ? 'text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent'
          : active
            ? 'bg-accent text-accent-foreground'
            : 'text-popover-foreground',
      )}
    >
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing !== undefined && trailing !== null ? (
        <span className="flex shrink-0 items-center gap-1">{trailing}</span>
      ) : null}
    </button>
  )
}

function ModelTags({ tags, size }: { tags: readonly ModelTag[]; size: 'row' | 'detail' }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className={cn(
            'inline-flex items-center font-medium',
            size === 'row' ? 'h-4 rounded px-1 text-[10px]' : 'h-5 rounded-md px-1.5 text-[10px]',
            MODEL_TAG_TONES[tag],
          )}
        >
          {MODEL_TAG_LABELS[tag]}
        </span>
      ))}
    </span>
  )
}
